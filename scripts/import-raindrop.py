#!/usr/bin/env python3
"""Stage Raindrop media, then atomically merge original dates into REF/VAULT.

Usage: python3 scripts/import-raindrop.py prepare [--inspector URL]
       python3 scripts/import-raindrop.py commit --plan PATH
Only images/videos enter the board. Original exports remain untouched.
"""
import argparse, concurrent.futures, csv, datetime as dt, hashlib, io, json, mimetypes, os, re, shutil, tempfile, time, unicodedata, urllib.parse, urllib.request, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIA_EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.mov', '.m4v', '.webm', '.avif', '.heic'}
META_FILES = {'export.csv', 'export.html', 'export.txt'}
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
ALIASES = {'градиенты': 'градиент', 'карточка': 'карточки', 'дашборды': 'дашборд'}
COLLECTION_ALIASES = {'интерфейсы': 'интерфейс'}

def canonical(value):
    return unicodedata.normalize('NFC', value).strip().casefold()

def uploaded(row):
    return bool(re.search(r'^https://api\.raindrop\.io/v2/raindrop/\d+/file(?:\?|$)', row['url']))

def original_name(row):
    cover = row.get('cover', '')
    if '/render/' in cover:
        cover = urllib.parse.unquote(cover.split('/render/', 1)[1])
    return urllib.parse.unquote(Path(urllib.parse.urlparse(cover).path).name)

def timestamp(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()

def sniff(head, name):
    if head.startswith(b'\xff\xd8\xff'): return 'image/jpeg', '.jpg'
    if head.startswith(b'\x89PNG\r\n\x1a\n'): return 'image/png', '.png'
    if head.startswith((b'GIF87a', b'GIF89a')): return 'image/gif', '.gif'
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP': return 'image/webp', '.webp'
    if head[:4] == b'\x1aE\xdf\xa3': return 'video/webm', '.webm'
    if len(head) > 12 and head[4:8] == b'ftyp':
        brand = head[8:12]
        if brand in (b'avif', b'avis'): return 'image/avif', '.avif'
        if brand in (b'heic', b'heix', b'mif1'): return 'image/heic', '.heic'
        return ('video/quicktime', '.mov') if brand == b'qt  ' else ('video/mp4', '.mp4')
    # Some older QuickTime clips begin with a wide/free atom.
    if Path(name).suffix.lower() in ('.mov', '.mp4', '.m4v') and head[4:8] in (b'moov', b'mdat', b'wide', b'free'):
        return 'video/quicktime', '.mov'
    raise ValueError('File is not a recognized image/video')

def source_name(url):
    host = (urllib.parse.urlparse(url).hostname or '').removeprefix('www.')
    for domain, name in [('dribbble.com','Dribbble'),('behance.net','Behance'),('pinterest.com','Pinterest'),('instagram.com','Instagram'),('are.na','Are.na')]:
        if host == domain or host.endswith('.' + domain): return name
    return host or 'Raindrop'

def write_json(path, value):
    temp = Path(str(path) + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temp.replace(path)

def download(url, directory, stem, referer=''):
    request = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36', 'Referer':referer or url})
    fd, tmp = tempfile.mkstemp(prefix='.raindrop-download-', dir=directory)
    try:
        with os.fdopen(fd, 'wb') as out, OPENER.open(request, timeout=20) as response:
            kind = response.headers.get('Content-Type', '').split(';')[0]
            if not (kind.startswith(('image/', 'video/')) or kind == 'application/octet-stream'):
                raise ValueError('Response is not image/video: ' + kind)
            size = 0
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > 500 * 1024 * 1024: raise ValueError('Media exceeds 500 MiB')
                out.write(chunk)
        with open(tmp, 'rb') as f: mime, ext = sniff(f.read(128), urllib.parse.urlparse(url).path)
        target = directory / (stem + ext)
        Path(tmp).replace(target)
        return media_record(target, mime, url)
    finally:
        if Path(tmp).exists(): Path(tmp).unlink()

def media_record(path, mime, remote_url):
    digest = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''): digest.update(chunk)
    return {'id':path.stem, 'type':'video' if mime.startswith('video/') else 'image', 'mime':mime, 'localUrl':'/media/' + path.name, 'remoteUrl':remote_url, 'size':path.stat().st_size, 'sha256':digest.hexdigest()}

def load_rows(folder):
    with zipfile.ZipFile(folder / 'export.zip') as archive:
        rows = list(csv.DictReader(io.StringIO(archive.read('export.csv').decode('utf-8-sig'))))
    by_id = {r['id']:r for r in rows}
    for filename in sorted(folder.glob('*.csv')):
        with filename.open(encoding='utf-8-sig', newline='') as f:
            for row in csv.DictReader(f):
                original = by_id.get(row['id'])
                if original:
                    for key, value in row.items():
                        if value: original[key] = value
                else:
                    by_id[row['id']] = row
    for row in by_id.values():
        if not re.fullmatch(r'\d+', row['id']): raise ValueError('Invalid Raindrop ID')
        timestamp(row['created'])
    return list(by_id.values())

def prepare(args):
    storage = args.storage.resolve();folder = args.folder.resolve();directory = storage / 'media';directory.mkdir(parents=True, exist_ok=True)
    report_dir = folder / ('import-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));report_dir.mkdir()
    db = json.loads((storage / 'db.json').read_text())
    rows = load_rows(folder);by_id = {r['id']:r for r in rows}
    tag_names = {canonical(t):t for item in db['items'] for t in item.get('tags', [])}
    collections = {canonical(item.get('collection','')):item.get('collection','') for item in db['items'] if item.get('collection')}
    existing = {str(item.get('raindrop',{}).get('id','')) for item in db['items']}
    local = {};matching_issues=[]
    with zipfile.ZipFile(folder / 'export.zip') as archive:
        for member in archive.infolist():
            if member.filename in META_FILES or member.is_dir(): continue
            stamp = dt.datetime(*member.date_time, tzinfo=dt.timezone.utc).timestamp()
            candidates = [r for r in rows if uploaded(r) and abs(timestamp(r['created']) - stamp) < 2.1 and (r['title'] == member.filename or original_name(r) == member.filename)]
            if len(candidates) != 1:
                matching_issues.append({'filename':member.filename, 'reason':'Ambiguous archive metadata', 'candidateIds':[r['id'] for r in candidates]});continue
            row = candidates[0]
            if row['id'] in existing: continue
            with archive.open(member) as f: mime, ext = sniff(f.read(128), member.filename)
            target = directory / ('raindrop-' + row['id'] + ext)
            # ZipInfo identifies the right member even when names occur repeatedly.
            with archive.open(member) as src, target.open('wb') as out: shutil.copyfileobj(src, out)
            local[row['id']] = [media_record(target, mime, row['url'])]
    print('Archive originals matched and staged:', len(local), flush=True)
    failures=[];excluded=[];external=[]
    for row in rows:
        if row['id'] in existing or row['id'] in local: continue
        if uploaded(row):
            kind=urllib.parse.parse_qs(urllib.parse.urlparse(row['url']).query).get('type',[''])[0]
            if not kind.startswith(('image/','video/')) and Path(row['title']).suffix.lower() not in MEDIA_EXTS:
                excluded.append({'id':row['id'],'title':row['title'],'reason':'Uploaded document is not image/video'});continue
            failures.append({'id':row['id'],'title':row['title'],'created':row['created'],'reason':'Original absent from ZIP; Raindrop file links require login'});continue
        url = urllib.parse.urlparse(row['url'])
        direct = Path(url.path).suffix.lower() in MEDIA_EXTS
        platform = (url.hostname or '').removeprefix('www.') in ('dribbble.com','behance.net','ru.pinterest.com','pinterest.com','instagram.com','are.na')
        if direct or (platform and args.inspector): external.append((row, direct))
        else: excluded.append({'id':row['id'],'title':row['title'],'reason':'Ordinary bookmark, not a direct media or supported reference link'})
    def fetch_media(job):
        row,direct=job;result=[];problems=[]
        try:
            if direct: candidates=[('image',row['url'])];posters={}
            else:
                payload=json.dumps({'url':row['url']}).encode()
                req=urllib.request.Request(args.inspector.rstrip('/')+'/api/inspect',data=payload,headers={'Content-Type':'application/json'})
                with OPENER.open(req,timeout=90) as response: inspection=json.load(response)
                candidates=[('image',u) for u in inspection.get('imageCandidates',[])]+[('video',u) for u in inspection.get('videoCandidates',[])]
                posters=inspection.get('videoPosters') or {}
            for i,(_,url) in enumerate(candidates):
                try:
                    record=download(url,directory,'raindrop-'+row['id']+'-'+str(i+1),row['url'])
                    if record['type']=='video' and posters.get(url):
                        try: record['posterUrl']=download(posters[url],directory,'raindrop-'+row['id']+'-poster-'+str(i+1),row['url'])['localUrl']
                        except Exception: pass # Local generator will produce a poster.
                    result.append(record)
                except Exception as error: problems.append({'id':row['id'],'reason':str(error)[:200]})
            if not result:
                return row['id'],[],[{**issue,'title':row['title']} for issue in problems] or [{'id':row['id'],'title':row['title'],'reason':'No accessible media found'}]
            return row['id'],result,problems
        except Exception as error:
            return row['id'],[],[{'id':row['id'],'title':row['title'],'reason':str(error)[:200]}]
    print('Direct media/reference links to process:',len(external),flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i,(ref_id,media,issues) in enumerate(pool.map(fetch_media,external),1):
            if media: local[ref_id]=media
            failures.extend(issues)
            if i%25==0 or i==len(external):print('Links processed: %d/%d; staged refs: %d'%(i,len(external),len(local)),flush=True)
    items=[];tag_mapping={};collection_mapping={}
    for ref_id,media in local.items():
        row=by_id[ref_id];tags=[]
        for original in row.get('tags','').split(','):
            original=original.strip()
            if not original:continue
            key=ALIASES.get(canonical(original),canonical(original));value=tag_names.setdefault(key,key)
            if value not in tags:tags.append(value)
            if original!=value:tag_mapping[original]=value
        original_collection=row.get('folder','').strip();key=canonical(original_collection)
        if key in ('unsorted','export',''):collection=''
        else:
            key=COLLECTION_ALIASES.get(key,key);collection=collections.setdefault(key,original_collection)
        if original_collection!=collection:collection_mapping[original_collection]=collection
        first=media[0];cover=first['localUrl'] if first['type']=='image' else first.get('posterUrl','')
        items.append({'id':'raindrop-'+ref_id,'createdAt':row['created'],'sourceUrl':row['url'],'source':'Raindrop' if uploaded(row) else source_name(row['url']),'title':row['title'],'description':row.get('excerpt',''),'note':row.get('note','') or row.get('excerpt',''),'collection':collection,'tags':tags,'coverUrl':cover,'coverMediaId':first['id'],'media':media,'mediaFound':len(media),'mediaArchived':len(media),'archiveErrors':[], 'raindrop':{'id':ref_id,'originalTags':row.get('tags',''),'originalCollection':original_collection,'favorite':row.get('favorite','')=='true','highlights':row.get('highlights','')}})
    items.sort(key=lambda x:timestamp(x['createdAt']),reverse=True)
    plan={'version':1,'storage':str(storage),'items':items,'tagMapping':tag_mapping,'collectionMapping':collection_mapping,'missingCollectionMetadata':sum(uploaded(by_id[x['raindrop']['id']]) and not by_id[x['raindrop']['id']].get('folder') for x in items),'unavailable':failures,'matchingIssues':matching_issues,'excludedBookmarks':excluded,'alreadyImported':len(existing- {''})}
    write_json(report_dir/'plan.json',plan)
    posters=[{'id':m['id'],'input':str(directory/Path(m['localUrl']).name),'output':str(directory/(m['id']+'-poster.jpg'))} for x in items for m in x['media'] if m['type']=='video' and not m.get('posterUrl')]
    write_json(report_dir/'poster-jobs.json',posters)
    print('Prepared plan:',report_dir/'plan.json',flush=True)
    print(json.dumps({'refs':len(items),'media':sum(len(x['media']) for x in items),'missingOrFailed':len(failures),'excludedBookmarks':len(excluded),'postersToGenerate':len(posters),'matchingIssues':len(matching_issues)},ensure_ascii=False),flush=True)

def commit(args):
    plan_path=args.plan.resolve();plan=json.loads(plan_path.read_text());storage=Path(plan['storage']);db_path=storage/'db.json'
    before=db_path.read_bytes();db=json.loads(before);existing_ids={x['id'] for x in db['items']};existing_raindrop={str(x.get('raindrop',{}).get('id','')) for x in db['items']}
    pending=[x for x in plan['items'] if x['id'] not in existing_ids and x['raindrop']['id'] not in existing_raindrop]
    if not pending:
        print('Already imported: no database changes or duplicates')
        return
    for item in pending:
        for media in item['media']:
            local=storage/'media'/Path(media['localUrl']).name
            if not local.is_file() or local.stat().st_size!=media['size']:raise ValueError('Missing or changed staged file: '+str(local))
            poster=storage/'media'/(media['id']+'-poster.jpg')
            if media['type']=='video' and not media.get('posterUrl') and poster.is_file():media['posterUrl']='/media/'+poster.name
        first=item['media'][0];item['coverUrl']=first['localUrl'] if first['type']=='image' else first.get('posterUrl','')
    backup=plan_path.parent/('db-before-'+dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'.json');backup.write_bytes(before)
    db['items'].extend(pending);db['items'].sort(key=lambda x:timestamp(x['createdAt']),reverse=True)
    if db_path.read_bytes()!=before:raise RuntimeError('Database changed during preparation; rerun commit')
    write_json(db_path,db)
    report={'imported':len(pending),'totalRefs':len(db['items']),'backup':str(backup),'dateRange':[min((x['createdAt'] for x in pending),default=None),max((x['createdAt'] for x in pending),default=None)],'media':sum(len(x['media']) for x in pending),'images':sum(m['type']=='image' for x in pending for m in x['media']),'videos':sum(m['type']=='video' for x in pending for m in x['media']),'videosWithoutPoster':sum(m['type']=='video' and not m.get('posterUrl') for x in pending for m in x['media']),'missingCollectionMetadata':plan['missingCollectionMetadata'],'tagMapping':plan['tagMapping'],'collectionMapping':plan['collectionMapping'],'unavailable':plan['unavailable'],'matchingIssues':plan['matchingIssues'],'excludedBookmarks':plan['excludedBookmarks']}
    write_json(plan_path.parent/'report.json',report);print(json.dumps({k:v for k,v in report.items() if k not in ('unavailable','matchingIssues','excludedBookmarks','tagMapping','collectionMapping')},ensure_ascii=False,indent=2));print('Report:',plan_path.parent/'report.json')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='command',required=True)
    prep=sub.add_parser('prepare');prep.add_argument('--storage',type=Path,default=ROOT/'data');prep.add_argument('--folder',type=Path,default=ROOT/'data/raindrop');prep.add_argument('--inspector');prep.add_argument('--workers',type=int,default=4)
    apply=sub.add_parser('commit');apply.add_argument('--plan',type=Path,required=True)
    args=parser.parse_args();prepare(args) if args.command=='prepare' else commit(args)

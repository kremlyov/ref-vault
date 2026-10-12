"""Build inspectable unsigned Apple Shortcut files; sign with Apple's shortcuts CLI."""
import plistlib
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def token(value):
    return {'Value': value, 'WFSerializationType': 'WFTextTokenAttachment'}

def text(string):
    return {'Value': {'string': string}, 'WFSerializationType': 'WFTextTokenString'}

def build(detailed):
    actions = []
    def action(name, **parameters):
        ident = str(uuid.uuid4()).upper()
        actions.append({'WFWorkflowActionIdentifier': 'is.workflow.actions.' + name,
                        'WFWorkflowActionParameters': {**parameters, 'UUID': ident}})
        return token({'Type': 'ActionOutput', 'OutputUUID': ident, 'OutputName': name})
    urls = action('geturl', WFInput=token({'Type': 'ExtensionInput'}))
    url = action('getitemfromlist', WFInput=urls, WFItemSpecifier='First Item')
    fields = {'url': url, 'tags': '', 'note': '', 'collection': ''}
    if detailed:
        for key, prompt in [('tags', 'Теги через запятую (можно оставить пустым)'), ('note', 'Заметка (можно оставить пустым)'), ('collection', 'Коллекция (можно оставить пустым)')]:
            fields[key] = action('ask', WFAskActionPrompt=prompt, WFInputType='Text', WFAskActionDefaultAnswer='')
    entries=[]
    for key,value in fields.items():
        val = text(value) if isinstance(value,str) else {
            'WFSerializationType':'WFTextTokenString',
            'Value':{'string':'\ufffc', 'attachmentsByRange':{'{0, 1}':value['Value']}}}
        entries.append({'WFItemType':0, 'WFKey':text(key), 'WFValue':val})
    dictionary = action('dictionary', WFItems={'Value':{'WFDictionaryFieldValueItems':entries}, 'WFSerializationType':'WFDictionaryFieldValue'})
    content = action('gettext', WFInput=dictionary)
    unique = action('generateuuid')
    name = {'WFSerializationType':'WFTextTokenString', 'Value':{'string':'\ufffc.json', 'attachmentsByRange':{'{0, 1}':unique['Value']}}}
    file = action('setitemname', WFInput=content, WFName=name)
    action('documentpicker.save', WFInput=file, WFAskWhereToSave=True, WFSaveFileOverwrite=False)
    return {'WFWorkflowClientRelease':'6.0', 'WFWorkflowClientVersion':'3036.0.4',
            'WFWorkflowMinimumClientVersion':900, 'WFWorkflowMinimumClientVersionString':'900',
            'WFWorkflowTypes':['ActionExtension'], 'WFWorkflowInputContentItemClasses':['WFURLContentItem','WFSafariWebPageContentItem','WFStringContentItem'],
            'WFWorkflowIcon':{'WFWorkflowIconStartColor':4282601983,'WFWorkflowIconGlyphNumber':59511},
            'WFWorkflowActions':actions, 'WFWorkflowImportQuestions':[]}

for detailed, name in [(False,'REF-VAULT Quick'),(True,'REF-VAULT With Notes')]:
    (ROOT/(name+'.unsigned.shortcut')).write_bytes(plistlib.dumps(build(detailed), fmt=plistlib.FMT_BINARY))

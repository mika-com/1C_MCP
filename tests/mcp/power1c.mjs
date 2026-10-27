#!/usr/bin/env node
// Тесты новых возможностей 1c-search (mcp/code-search.mjs, mcp/lib/query-validator.mjs, mcp/lib/event-log.mjs):
// 1. Граф метаданных и неявных связей (object_refs, типы, подписки, движения, CFE-перехваты, Form.xml в find_usages)
// 2. Статический валидатор запросов 1С по метаданным (validate_query)
// 3. Чтение Журнала регистрации 1С (event_log: SQLite 1Cv8.lgd и текстовый 1Cv8.lgf + *.lgp со стек-трейсами BSL)
//   node tests/mcp/power1c.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildIndex, findObject, findMethod, moduleMethods, findUsages, objectRefs } from '../../mcp/code-search.mjs';
import { validateQuery } from '../../mcp/lib/query-validator.mjs';
import { readEventLog } from '../../mcp/lib/event-log.mjs';

let passed = 0; let failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? `\n       ${String(extra).split('\n').join('\n       ')}` : ''}`);
  }
};

function makeRichProject() {
  const root = mkdtempSync(join(tmpdir(), 'power1c-'));
  const cf = join(root, 'src', 'cf');
  const cfe = join(root, 'src', 'cfe', 'МоёРасширение');

  for (const d of [
    join(cf, 'Catalogs'),
    join(cf, 'Documents', 'ЗаказКлиента', 'Ext'),
    join(cf, 'Documents', 'ЗаказКлиента', 'Forms', 'ФормаДокумента', 'Ext', 'Form'),
    join(cf, 'Documents', 'РеализацияТоваров'),
    join(cf, 'Enums'),
    join(cf, 'DefinedTypes'),
    join(cf, 'AccumulationRegisters'),
    join(cf, 'InformationRegisters'),
    join(cf, 'EventSubscriptions'),
    join(cf, 'ScheduledJobs'),
    join(cf, 'HTTPServices'),
    join(cf, 'CommonModules', 'ПродажиСервер', 'Ext'),
    join(cf, 'CommonAttributes'),
    join(cf, 'FunctionalOptions'),
    join(cfe, 'Documents', 'ЗаказКлиента', 'Ext'),
  ]) {
    mkdirSync(d, { recursive: true });
  }

  writeFileSync(join(cf, 'Configuration.xml'),
    '<MetaDataObject><Configuration><Properties><Name>УТ</Name></Properties></Configuration></MetaDataObject>');
  writeFileSync(join(cfe, 'Configuration.xml'),
    '<MetaDataObject><Configuration><Properties><Name>МоёРасширение</Name><ConfigurationExtensionPurpose>Customization</ConfigurationExtensionPurpose><NamePrefix>МР_</NamePrefix></Properties></Configuration></MetaDataObject>');

  // Справочник.Контрагенты
  writeFileSync(join(cf, 'Catalogs', 'Контрагенты.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable">
  <Catalog>
    <Properties>
      <Name>Контрагенты</Name>
      <Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>Контрагенты</v8:content></v8:item></Synonym>
      <Hierarchical>true</Hierarchical>
      <CodeLength>9</CodeLength>
      <DescriptionLength>100</DescriptionLength>
    </Properties>
    <ChildObjects>
      <Attribute><Properties><Name>ИНН</Name><Type><v8:Type>xs:string</v8:Type><v8:StringQualifiers><v8:Length>12</v8:Length></v8:StringQualifiers></Type></Properties></Attribute>
      <Attribute><Properties><Name>ОсновнойДоговор</Name><Type><v8:Type>cfg:CatalogRef.ДоговорыКонтрагентов</v8:Type></Type></Properties></Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`);

  // Справочник.ДоговорыКонтрагентов (подчинён Контрагенты)
  writeFileSync(join(cf, 'Catalogs', 'ДоговорыКонтрагентов.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable">
  <Catalog>
    <Properties>
      <Name>ДоговорыКонтрагентов</Name>
      <Owners><xr:Item>Catalog.Контрагенты</xr:Item></Owners>
      <CodeLength>9</CodeLength>
      <DescriptionLength>100</DescriptionLength>
    </Properties>
    <ChildObjects>
      <Attribute><Properties><Name>СуммаЛимита</Name><Type><v8:TypeSet>cfg:DefinedType.ДенежнаяСумма</v8:TypeSet></Type></Properties></Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`);

  // Справочник.Номенклатура
  writeFileSync(join(cf, 'Catalogs', 'Номенклатура.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Catalog>
    <Properties>
      <Name>Номенклатура</Name>
      <CodeLength>11</CodeLength>
      <DescriptionLength>150</DescriptionLength>
    </Properties>
    <ChildObjects>
      <Attribute><Properties><Name>Артикул</Name><Type><v8:Type>xs:string</v8:Type><v8:StringQualifiers><v8:Length>50</v8:Length></v8:StringQualifiers></Type></Properties></Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`);

  // Перечисление.СтатусыЗаказа
  writeFileSync(join(cf, 'Enums', 'СтатусыЗаказа.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Enum>
    <Properties><Name>СтатусыЗаказа</Name></Properties>
    <ChildObjects>
      <EnumValue><Properties><Name>ВРаботе</Name></Properties></EnumValue>
      <EnumValue><Properties><Name>Согласован</Name></Properties></EnumValue>
      <EnumValue><Properties><Name>Отменен</Name></Properties></EnumValue>
    </ChildObjects>
  </Enum>
</MetaDataObject>`);

  // ОпределяемыйТип.ДенежнаяСумма и ОпределяемыйТип.ДокументПродажи
  writeFileSync(join(cf, 'DefinedTypes', 'ДенежнаяСумма.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <DefinedType>
    <Properties>
      <Name>ДенежнаяСумма</Name>
      <Type><v8:Type>xs:decimal</v8:Type><v8:NumberQualifiers><v8:Digits>15</v8:Digits><v8:FractionDigits>2</v8:FractionDigits></v8:NumberQualifiers></Type>
    </Properties>
  </DefinedType>
</MetaDataObject>`);

  writeFileSync(join(cf, 'DefinedTypes', 'ДокументПродажи.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <DefinedType>
    <Properties>
      <Name>ДокументПродажи</Name>
      <Type>
        <v8:Type>cfg:DocumentRef.ЗаказКлиента</v8:Type>
        <v8:Type>cfg:DocumentObject.ЗаказКлиента</v8:Type>
      </Type>
    </Properties>
  </DefinedType>
</MetaDataObject>`);

  // Документ.ЗаказКлиента
  writeFileSync(join(cf, 'Documents', 'ЗаказКлиента.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable">
  <Document>
    <Properties>
      <Name>ЗаказКлиента</Name>
      <Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>Заказ клиента</v8:content></v8:item></Synonym>
      <NumberLength>11</NumberLength>
      <RegisterRecords>
        <xr:Item>AccumulationRegister.ТоварыНаСкладах</xr:Item>
        <xr:Item>InformationRegister.ЦеныНоменклатуры</xr:Item>
      </RegisterRecords>
    </Properties>
    <ChildObjects>
      <Attribute><Properties><Name>Контрагент</Name><Type><v8:Type>cfg:CatalogRef.Контрагенты</v8:Type></Type></Properties></Attribute>
      <Attribute><Properties><Name>Договор</Name><Type><v8:Type>cfg:CatalogRef.ДоговорыКонтрагентов</v8:Type></Type></Properties></Attribute>
      <Attribute><Properties><Name>Статус</Name><Type><v8:Type>cfg:EnumRef.СтатусыЗаказа</v8:Type></Type></Properties></Attribute>
      <Attribute><Properties><Name>СуммаДокумента</Name><Type><v8:TypeSet>cfg:DefinedType.ДенежнаяСумма</v8:TypeSet></Type></Properties></Attribute>
      <TabularSection>
        <Properties><Name>Товары</Name></Properties>
        <ChildObjects>
          <Attribute><Properties><Name>Номенклатура</Name><Type><v8:Type>cfg:CatalogRef.Номенклатура</v8:Type></Type></Properties></Attribute>
          <Attribute><Properties><Name>Количество</Name><Type><v8:Type>xs:decimal</v8:Type><v8:NumberQualifiers><v8:Digits>15</v8:Digits><v8:FractionDigits>3</v8:FractionDigits></v8:NumberQualifiers></Type></Properties></Attribute>
          <Attribute><Properties><Name>Сумма</Name><Type><v8:TypeSet>cfg:DefinedType.ДенежнаяСумма</v8:TypeSet></Type></Properties></Attribute>
        </ChildObjects>
      </TabularSection>
    </ChildObjects>
  </Document>
</MetaDataObject>`);

  // Документ.РеализацияТоваров (вводится на основании ЗаказКлиента, ссылается на него)
  writeFileSync(join(cf, 'Documents', 'РеализацияТоваров.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable">
  <Document>
    <Properties>
      <Name>РеализацияТоваров</Name>
      <BasedOn><xr:Item>Document.ЗаказКлиента</xr:Item></BasedOn>
    </Properties>
    <ChildObjects>
      <Attribute><Properties><Name>ЗаказОснование</Name><Type><v8:Type>cfg:DocumentRef.ЗаказКлиента</v8:Type></Type></Properties></Attribute>
    </ChildObjects>
  </Document>
</MetaDataObject>`);

  // РегистрНакопления.ТоварыНаСкладах (остатки) и ОборотыПродаж (обороты)
  writeFileSync(join(cf, 'AccumulationRegisters', 'ТоварыНаСкладах.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <AccumulationRegister>
    <Properties>
      <Name>ТоварыНаСкладах</Name>
      <RegisterType>Balances</RegisterType>
    </Properties>
    <ChildObjects>
      <Dimension><Properties><Name>Номенклатура</Name><Type><v8:Type>cfg:CatalogRef.Номенклатура</v8:Type></Type></Properties></Dimension>
      <Resource><Properties><Name>ВНаличии</Name><Type><v8:Type>xs:decimal</v8:Type><v8:NumberQualifiers><v8:Digits>15</v8:Digits><v8:FractionDigits>3</v8:FractionDigits></v8:NumberQualifiers></Type></Properties></Resource>
    </ChildObjects>
  </AccumulationRegister>
</MetaDataObject>`);

  writeFileSync(join(cf, 'AccumulationRegisters', 'ОборотыПродаж.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <AccumulationRegister>
    <Properties>
      <Name>ОборотыПродаж</Name>
      <RegisterType>Turnovers</RegisterType>
    </Properties>
    <ChildObjects>
      <Dimension><Properties><Name>Номенклатура</Name><Type><v8:Type>cfg:CatalogRef.Номенклатура</v8:Type></Type></Properties></Dimension>
      <Dimension><Properties><Name>Заказ</Name><Type><v8:TypeSet>cfg:DefinedType.ДокументПродажи</v8:TypeSet></Type></Properties></Dimension>
      <Resource><Properties><Name>Стоимость</Name><Type><v8:TypeSet>cfg:DefinedType.ДенежнаяСумма</v8:TypeSet></Type></Properties></Resource>
    </ChildObjects>
  </AccumulationRegister>
</MetaDataObject>`);

  // РегистрСведений.ЦеныНоменклатуры (периодический) и НастройкиСистемы (непериодический)
  writeFileSync(join(cf, 'InformationRegisters', 'ЦеныНоменклатуры.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <InformationRegister>
    <Properties>
      <Name>ЦеныНоменклатуры</Name>
      <InformationRegisterPeriodicity>Day</InformationRegisterPeriodicity>
      <WriteMode>RecorderSubordinate</WriteMode>
    </Properties>
    <ChildObjects>
      <Dimension><Properties><Name>Номенклатура</Name><Type><v8:Type>cfg:CatalogRef.Номенклатура</v8:Type></Type></Properties></Dimension>
      <Resource><Properties><Name>Цена</Name><Type><v8:TypeSet>cfg:DefinedType.ДенежнаяСумма</v8:TypeSet></Type></Properties></Resource>
    </ChildObjects>
  </InformationRegister>
</MetaDataObject>`);

  writeFileSync(join(cf, 'InformationRegisters', 'НастройкиСистемы.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <InformationRegister>
    <Properties>
      <Name>НастройкиСистемы</Name>
      <InformationRegisterPeriodicity>Nonperiodical</InformationRegisterPeriodicity>
      <WriteMode>Independent</WriteMode>
    </Properties>
    <ChildObjects>
      <Dimension><Properties><Name>КлючНастройки</Name><Type><v8:Type>xs:string</v8:Type><v8:StringQualifiers><v8:Length>50</v8:Length></v8:StringQualifiers></Type></Properties></Dimension>
      <Resource><Properties><Name>ЗначениеНастройки</Name><Type><v8:Type>xs:string</v8:Type><v8:StringQualifiers><v8:Length>200</v8:Length></v8:StringQualifiers></Type></Properties></Resource>
    </ChildObjects>
  </InformationRegister>
</MetaDataObject>`);

  // Подписки на события
  writeFileSync(join(cf, 'EventSubscriptions', 'КонтрольЛимитаЗаказа.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <EventSubscription>
    <Properties>
      <Name>КонтрольЛимитаЗаказа</Name>
      <Source><v8:Type>cfg:DocumentObject.ЗаказКлиента</v8:Type></Source>
      <Event>BeforeWrite</Event>
      <Handler>CommonModule.ПродажиСервер.КонтрольЛимитаПередЗаписью</Handler>
    </Properties>
  </EventSubscription>
</MetaDataObject>`);

  writeFileSync(join(cf, 'EventSubscriptions', 'РегистрацияДокументовПродажи.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <EventSubscription>
    <Properties>
      <Name>РегистрацияДокументовПродажи</Name>
      <Source><v8:TypeSet>cfg:DefinedType.ДокументПродажи</v8:TypeSet></Source>
      <Event>Posting</Event>
      <Handler>CommonModule.ПродажиСервер.ПриПроведенииДокументаПродажи</Handler>
    </Properties>
  </EventSubscription>
</MetaDataObject>`);

  // Регламентное задание и HTTP-сервис
  writeFileSync(join(cf, 'ScheduledJobs', 'ЗакрытиеПросроченныхЗаказов.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <ScheduledJob>
    <Properties>
      <Name>ЗакрытиеПросроченныхЗаказов</Name>
      <MethodName>CommonModule.ПродажиСервер.ЗакрытьПросроченныеЗаказыРегламентное</MethodName>
      <Use>true</Use>
    </Properties>
  </ScheduledJob>
</MetaDataObject>`);

  writeFileSync(join(cf, 'HTTPServices', 'OrdersAPI.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <HTTPService>
    <Properties><Name>OrdersAPI</Name><RootURL>orders</RootURL></Properties>
    <ChildObjects>
      <URLTemplate>
        <Properties><Name>Статус</Name><Template>/status</Template></Properties>
        <ChildObjects>
          <Method><Properties><Name>GET</Name><HTTPMethod>GET</HTTPMethod><Handler>СтатусGET</Handler></Properties></Method>
        </ChildObjects>
      </URLTemplate>
    </ChildObjects>
  </HTTPService>
</MetaDataObject>`);

  // ОбщийРеквизит.Организация и ФункциональнаяОпция.ИспользоватьЗаказы
  writeFileSync(join(cf, 'CommonAttributes', 'Организация.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable">
  <CommonAttribute>
    <Properties>
      <Name>Организация</Name>
      <Type><v8:Type>xs:string</v8:Type><v8:StringQualifiers><v8:Length>50</v8:Length></v8:StringQualifiers></Type>
      <AutoUse>DontUse</AutoUse>
      <Content>
        <xr:Item><xr:Metadata>Document.ЗаказКлиента</xr:Metadata><xr:Use>Use</xr:Use></xr:Item>
      </Content>
    </Properties>
  </CommonAttribute>
</MetaDataObject>`);

  writeFileSync(join(cf, 'FunctionalOptions', 'ИспользоватьЗаказы.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:xr="http://v8.1c.ru/8.3/xcf/readable">
  <FunctionalOption>
    <Properties>
      <Name>ИспользоватьЗаказы</Name>
      <Content><xr:Object>Document.ЗаказКлиента</xr:Object></Content>
    </Properties>
  </FunctionalOption>
</MetaDataObject>`);

  // Модули BSL в основной конфигурации
  writeFileSync(join(cf, 'CommonModules', 'ПродажиСервер', 'Ext', 'Module.bsl'),
`Процедура КонтрольЛимитаПередЗаписью(Источник, Отказ) Экспорт
	Если Источник.СуммаДокумента < 0 Тогда
		ВызватьИсключение "Сумма не может быть отрицательной";
	КонецЕсли;
КонецПроцедуры

Процедура ПриПроведенииДокументаПродажи(Источник, Отказ) Экспорт
КонецПроцедуры

Процедура ЗакрытьПросроченныеЗаказыРегламентное() Экспорт
КонецПроцедуры
`);

  writeFileSync(join(cf, 'Documents', 'ЗаказКлиента', 'Ext', 'ObjectModule.bsl'),
`Процедура ПередЗаписью(Отказ, РежимЗаписи, РежимПроведения)
КонецПроцедуры

Процедура ОбработкаПроведения(Отказ, РежимПроведения)
	Движения.ТоварыНаСкладах.Записывать = Истина;
	Для Каждого СтрокаТЧ Из Товары Цикл
		Если СтрокаТЧ.Количество <= 0 Тогда
			ВызватьИсключение "Количество должно быть больше нуля";
		КонецЕсли;
	КонецЦикла;
КонецПроцедуры
`);

  // Форма документа с событиями и командами
  writeFileSync(join(cf, 'Documents', 'ЗаказКлиента', 'Forms', 'ФормаДокумента', 'Ext', 'Form.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform">
  <Events>
    <Event name="OnCreateAtServer">ПриСозданииНаСервере</Event>
  </Events>
  <ChildItems>
    <InputField name="Контрагент" id="1">
      <Events><Event name="OnChange">КонтрагентПриИзменении</Event></Events>
    </InputField>
  </ChildItems>
  <Commands>
    <Command name="ЗаполнитьЦены" id="1">
      <Action>ЗаполнитьЦеныКоманда</Action>
    </Command>
  </Commands>
</Form>`);

  writeFileSync(join(cf, 'Documents', 'ЗаказКлиента', 'Forms', 'ФормаДокумента', 'Ext', 'Form', 'Module.bsl'),
`&НаСервере
Процедура ПриСозданииНаСервере(Отказ, СтандартнаяОбработка)
КонецПроцедуры

&НаКлиенте
Процедура КонтрагентПриИзменении(Элемент)
КонецПроцедуры

&НаКлиенте
Процедура ЗаполнитьЦеныКоманда(Команда)
КонецПроцедуры
`);

  // Расширение CFE: заимствованный Документ.ЗаказКлиента с доп. реквизитом и перехватом ОбработкаПроведения
  writeFileSync(join(cfe, 'Documents', 'ЗаказКлиента.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Document>
    <Properties>
      <Name>ЗаказКлиента</Name>
      <ObjectBelonging>Adopted</ObjectBelonging>
    </Properties>
    <ChildObjects>
      <Attribute><Properties><Name>МР_ВнешнийНомер</Name><Type><v8:Type>xs:string</v8:Type><v8:StringQualifiers><v8:Length>30</v8:Length></v8:StringQualifiers></Type></Properties></Attribute>
    </ChildObjects>
  </Document>
</MetaDataObject>`);

  writeFileSync(join(cfe, 'Documents', 'ЗаказКлиента', 'Ext', 'ObjectModule.bsl'),
`&НаСервере
&После("ОбработкаПроведения")
Процедура МР_ОбработкаПроведения(Отказ, РежимПроведения)
	// Дополнительная логика расширения после проведения
КонецПроцедуры
`);

  return root;
}

const root = makeRichProject();
const idx = buildIndex(root, { force: true });

console.log('1. Граф метаданных и неявных связей (object_refs, find_method, find_usages):');
{
  const refsOrder = objectRefs(idx, { object: 'Документ.ЗаказКлиента' });
  ok(/Движения документа по регистрам \(2\)/.test(refsOrder) &&
     /РегистрНакопления\.ТоварыНаСкладах/.test(refsOrder) &&
     /РегистрСведений\.ЦеныНоменклатуры/.test(refsOrder),
     'object_refs(Документ.ЗаказКлиента): видит движения по регистрам (RegisterRecords)', refsOrder);

  ok(/На основании него вводятся: Документ\.РеализацияТоваров/.test(refsOrder),
     'object_refs(Документ.ЗаказКлиента): видит обратный ввод на основании (BasedOn)', refsOrder);

  ok(/ПодпискаНаСобытие\.КонтрольЛимитаЗаказа.*ПередЗаписью.*ОбщийМодуль\.ПродажиСервер\.КонтрольЛимитаПередЗаписью.*прямая привязка/.test(refsOrder) &&
     /ПодпискаНаСобытие\.РегистрацияДокументовПродажи.*ОбработкаПроведения.*через ОпределяемыйТип\.ДокументПродажи/.test(refsOrder),
     'object_refs(Документ.ЗаказКлиента): видит прямые подписки и подписки через ОпределяемыйТип', refsOrder);

  ok(/Заимствован в расширении \[src\/cfe\/МоёРасширение\].*реквизиты в расширении: МР_ВнешнийНомер/.test(refsOrder) &&
     /Перехват метода в \[src\/cfe\/МоёРасширение\].*&После\("ОбработкаПроведения"\) → Процедура МР_ОбработкаПроведения/.test(refsOrder),
     'object_refs(Документ.ЗаказКлиента): видит заимствование, реквизиты и перехваты в расширении CFE', refsOrder);

  ok(/Документ\.РеализацияТоваров\.ЗаказОснование \(реквизит, тип: ДокументСсылка\.ЗаказКлиента\)/.test(refsOrder) &&
     /РегистрНакопления\.ОборотыПродаж\.Заказ \(измерение, тип: через ОпределяемыйТип\.ДокументПродажи\)/.test(refsOrder),
     'object_refs(Документ.ЗаказКлиента): находит where-used как напрямую, так и через ОпределяемыйТип', refsOrder);

  ok(/Общие реквизиты объекта: Организация/.test(refsOrder) &&
     /Функциональные опции: ИспользоватьЗаказы/.test(refsOrder),
     'object_refs(Документ.ЗаказКлиента): видит ОбщиеРеквизиты и ФункциональныеОпции', refsOrder);

  // Регистр видит свои регистраторы
  const refsReg = objectRefs(idx, { object: 'РегистрНакопления.ТоварыНаСкладах' });
  ok(/Регистраторы \(документы, двигающие регистр\) \(1\):[\s\S]*Документ\.ЗаказКлиента/.test(refsReg),
     'object_refs(РегистрНакопления.ТоварыНаСкладах): видит документы-регистраторы', refsReg);

  // Подчинённость справочников
  const refsPartner = objectRefs(idx, { object: 'Справочник.Контрагенты' });
  ok(/Подчинённые справочники: Справочник\.ДоговорыКонтрагентов/.test(refsPartner),
     'object_refs(Справочник.Контрагенты): видит подчинённые справочники', refsPartner);

  // find_method показывает и базовый метод, и перехватчик в CFE
  const fm = findMethod(idx, { name: 'ОбработкаПроведения', object: 'Документ.ЗаказКлиента' });
  ok(/ObjectModule\.bsl:4-11/.test(fm) &&
     /МР_ОбработкаПроведения.*\[перехват &После\("ОбработкаПроведения"\)\]/.test(fm),
     'find_method(ОбработкаПроведения): возвращает базовый метод + перехватчик в расширении CFE', fm);

  // find_usages находит обработчики в подписках, регламентных заданиях, HTTP-сервисах, Form.xml и перехватах CFE
  const uSub = findUsages(idx, { name: 'КонтрольЛимитаПередЗаписью' });
  ok(/\[ПодпискаНаСобытие\.КонтрольЛимитаЗаказа\] событие ПередЗаписью/.test(uSub),
     'find_usages: находит привязку метода в ПодпискаНаСобытие', uSub);

  const uJob = findUsages(idx, { name: 'ЗакрытьПросроченныеЗаказыРегламентное' });
  ok(/\[РегламентноеЗадание\.ЗакрытиеПросроченныхЗаказов\]/.test(uJob),
     'find_usages: находит привязку метода в РегламентноеЗадание', uJob);

  const uHttp = findUsages(idx, { name: 'СтатусGET' });
  ok(/\[HTTPСервис\.OrdersAPI\] GET \/status → СтатусGET/.test(uHttp),
     'find_usages: находит обработчик HTTPСервиса', uHttp);

  const uFormEvt = findUsages(idx, { name: 'КонтрагентПриИзменении' });
  ok(/\[Документ\.ЗаказКлиента\.Форма\.ФормаДокумента\] событие формы\/элемента OnChange → КонтрагентПриИзменении/.test(uFormEvt),
     'find_usages: находит обработчик события элемента в Form.xml', uFormEvt);

  const uFormCmd = findUsages(idx, { name: 'ЗаполнитьЦеныКоманда' });
  ok(/\[Документ\.ЗаказКлиента\.Форма\.ФормаДокумента\] команда формы ЗаполнитьЦены → ЗаполнитьЦеныКоманда/.test(uFormCmd),
     'find_usages: находит обработчик команды в Form.xml', uFormCmd);

  const uIntercept = findUsages(idx, { name: 'ОбработкаПроведения', object: 'Документ.ЗаказКлиента' });
  ok(/\[Перехват CFE в Документ\.ЗаказКлиента\.МодульОбъекта.*&После\("ОбработкаПроведения"\) → МР_ОбработкаПроведения/.test(uIntercept),
     'find_usages: находит перехват метода в расширении CFE', uIntercept);
}

console.log('2. Статический валидатор запросов 1С (validate_query):');
{
  // Корректный пакетный запрос с ВТ, виртуальными таблицами, цепочками через точку, общим реквизитом и реквизитом из расширения
  const validQuery = `
    "ВЫБРАТЬ
    |	Заказ.Ссылка КАК Заказ,
    |	Заказ.Организация КАК Организация,
    |	Заказ.МР_ВнешнийНомер КАК ВнешнийНомер,
    |	Заказ.Контрагент.ИНН КАК ИНН,
    |	Заказ.Договор.Владелец.Наименование КАК ИмяВладельца,
    |	Заказ.Товары.Номенклатура.Артикул КАК Артикул,
    |	Цены.Цена КАК Цена,
    |	Остатки.ВНаличииОстаток КАК Остаток
    |ПОМЕСТИТЬ ВТ_ДанныеЗаказа
    |ИЗ
    |	Документ.ЗаказКлиента КАК Заказ
    |		ЛЕВОЕ СОЕДИНЕНИЕ РегистрСведений.ЦеныНоменклатуры.СрезПоследних(&Дата, Номенклатура В (ВЫБРАТЬ Т.Номенклатура ИЗ Документ.ЗаказКлиента.Товары КАК Т)) КАК Цены
    |		ПО Заказ.Товары.Номенклатура = Цены.Номенклатура
    |		ЛЕВОЕ СОЕДИНЕНИЕ РегистрНакопления.ТоварыНаСкладах.Остатки(&Дата) КАК Остатки
    |		ПО Заказ.Товары.Номенклатура = Остатки.Номенклатура
    |ГДЕ
    |	Заказ.Статус = ЗНАЧЕНИЕ(Перечисление.СтатусыЗаказа.Согласован)
    |	И Заказ.Проведен = ИСТИНА
    |;
    |ВЫБРАТЬ
    |	ВТ.Заказ.Номер,
    |	ВТ.ИНН,
    |	ВТ.Остаток
    |ИЗ
    |	ВТ_ДанныеЗаказа КАК ВТ"
  `;
  const rOk = validateQuery(idx, { query: validQuery });
  ok(/^\[OK\] Запрос корректен по схеме метаданных/.test(rOk), 'validate_query: корректный пакетный запрос проходит без ошибок', rOk);

  // Ошибка 1: несуществующий объект метаданных с подсказкой
  const rBadTable = validateQuery(idx, { query: 'ВЫБРАТЬ Ссылка ИЗ Документ.ЗаказыКлиента' });
  ok(/\[ОШИБКА\].*Документ\.ЗаказыКлиента.*не найден.*Похожие объекты: ЗаказКлиента/.test(rBadTable),
     'validate_query: ловит опечатку в имени таблицы и подсказывает Документ.ЗаказКлиента', rBadTable);

  // Ошибка 2: несуществующий реквизит и цепочка через точку
  const rBadAttr = validateQuery(idx, {
    query: 'ВЫБРАТЬ Заказ.Контрагенты, Заказ.Контрагент.ИННКомпании ИЗ Документ.ЗаказКлиента КАК Заказ',
  });
  ok(/Поле «Контрагенты» не найдено в «Документ\.ЗаказКлиента».*Похожие поля: Контрагент/.test(rBadAttr) &&
     /Поле «ИННКомпании» не найдено в «Справочник\.Контрагенты».*Похожие поля: ИНН/.test(rBadAttr),
     'validate_query: ловит опечатки в реквизите документа и в цепочке через точку Заказ.Контрагент.ИННКомпании', rBadAttr);

  // Ошибка 3: разыменование примитивного типа через точку
  const rPrim = validateQuery(idx, {
    query: 'ВЫБРАТЬ Заказ.СуммаДокумента.Наименование ИЗ Документ.ЗаказКлиента КАК Заказ',
  });
  ok(/Обращение через точку от примитивного поля «Документ\.ЗаказКлиента\.СуммаДокумента».*недопустимо/.test(rPrim),
     'validate_query: запрещает обращение через точку от примитивного типа (в т.ч. через ОпределяемыйТип.ДенежнаяСумма)', rPrim);

  // Ошибка 4: СрезПоследних у непериодического РС и Остатки у оборотного РН
  const rBadVt = validateQuery(idx, {
    query: `
      ВЫБРАТЬ * ИЗ РегистрСведений.НастройкиСистемы.СрезПоследних;
      ВЫБРАТЬ * ИЗ РегистрНакопления.ОборотыПродаж.Остатки
    `,
  });
  ok(/РегистрСведений\.НастройкиСистемы является непериодическим — виртуальная таблица «СрезПоследних» для него недоступна/.test(rBadVt) &&
     /РегистрНакопления\.ОборотыПродаж — оборотный регистр \(Turnovers\), виртуальная таблица «Остатки» недоступна/.test(rBadVt),
     'validate_query: проверяет допустимость виртуальных таблиц СрезПоследних и Остатки по свойствам регистра', rBadVt);

  // Ошибка 5: несуществующее значение перечисления в ЗНАЧЕНИЕ(...)
  const rBadEnum = validateQuery(idx, {
    query: 'ВЫБРАТЬ Ссылка ИЗ Документ.ЗаказКлиента ГДЕ Статус = ЗНАЧЕНИЕ(Перечисление.СтатусыЗаказа.ОтмененКлиентом)',
  });
  ok(/значение перечисления «ОтмененКлиентом» не найдено в «Перечисление\.СтатусыЗаказа».*Похожие: Отменен/.test(rBadEnum),
     'validate_query: проверяет существование значения перечисления внутри ЗНАЧЕНИЕ(...)', rBadEnum);

  // Ошибка 6: несуществующая колонка во временной таблице пакета
  const rBadTempCol = validateQuery(idx, {
    query: `
      ВЫБРАТЬ Ссылка КАК Док, СуммаДокумента КАК Сумма ПОМЕСТИТЬ ВТ ИЗ Документ.ЗаказКлиента;
      ВЫБРАТЬ ВТ.Док, ВТ.СуммаЗаказа ИЗ ВТ КАК ВТ
    `,
  });
  ok(/Поле «СуммаЗаказа» не найдено в «ВТ «ВТ»».*Похожие поля: Сумма/.test(rBadTempCol),
     'validate_query: отслеживает схему временной таблицы ПОМЕСТИТЬ ВТ между запросами пакета', rBadTempCol);
}

console.log('3. Чтение Журнала регистрации 1С (event_log: SQLite .lgd и текстовый .lgp + .lgf):');
{
  // 3.1 Создаём тестовую базу с 1Cv8Log/1Cv8.lgd (SQLite) и прописываем её в .v8-project.json
  const ibDir = join(root, 'build', 'ib');
  const logDir = join(ibDir, '1Cv8Log');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(root, '.v8-project.json'), JSON.stringify({
    databases: [{ id: 'dev', name: 'Разработка', type: 'file', path: 'build/ib' }],
    default: 'dev',
  }));

  const lgdPath = join(logDir, '1Cv8.lgd');
  const db = new DatabaseSync(lgdPath);
  db.exec(`
    CREATE TABLE UserCodes (Code INTEGER PRIMARY KEY, Name TEXT, UUID TEXT);
    CREATE TABLE AppCodes (Code INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE EventCodes (Code INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE MetadataCodes (Code INTEGER PRIMARY KEY, Name TEXT, UUID TEXT);
    CREATE TABLE EventLogMetadata (EventLogID INTEGER, MetadataCode INTEGER);
    CREATE TABLE EventLog (
      RowID INTEGER PRIMARY KEY,
      Date INTEGER,
      ConnectID INTEGER,
      Session INTEGER,
      TransactionStatus INTEGER,
      UserCode INTEGER,
      AppCode INTEGER,
      EventCode INTEGER,
      Severity INTEGER,
      Comment TEXT,
      DataPresentation TEXT
    );
    INSERT INTO UserCodes VALUES (1, 'Администратор', '00000000-0000-0000-0000-000000000001');
    INSERT INTO AppCodes VALUES (1, '1CV8C');
    INSERT INTO EventCodes VALUES (1, '_$Session$_.Start'), (2, '_$PerformError$_');
    INSERT INTO MetadataCodes VALUES (10, 'Документ.ЗаказКлиента', '11111111-1111-1111-1111-111111111111');
    INSERT INTO EventLog VALUES
      (1, 639284778000000, 1, 1, 0, 1, 1, 1, 1, 'Сеанс запущен', ''),
      (2, 639284778150000, 1, 1, 3, 1, 1, 2, 3,
       'Ошибка при выполнении обработчика - ''ОбработкаПроведения''\nпо причине:\n{Документ.ЗаказКлиента.МодульОбъекта(8)}: Количество должно быть больше нуля',
       'Заказ клиента 0000-000012 от 24.10.2026');
    INSERT INTO EventLogMetadata VALUES (2, 10);
  `);
  db.close();

  const logOut = await readEventLog(idx, { errors_only: true });
  ok(/\[Ошибка\] 2026-10-24 22:30:15 — Ошибка выполнения \(_\$PerformError\$_\)/.test(logOut) &&
     /Документ\.ЗаказКлиента · Заказ клиента 0000-000012/.test(logOut) &&
     /Файл в проекте: src\/cf\/Documents\/ЗаказКлиента\/Ext\/ObjectModule\.bsl:8 \(Процедура ОбработкаПроведения\)/.test(logOut) &&
     />> 8:\s+ВызватьИсключение "Количество должно быть больше нуля";/.test(logOut),
     'event_log (SQLite 1Cv8.lgd): читает ошибку, декодирует дату 1С и привязывает стек-трейс к файлу, строке и коду в проекте', logOut);

  const allOut = await readEventLog(idx, { errors_only: false });
  ok(/Начало сеанса/.test(allOut) && /Ошибка выполнения/.test(allOut),
     'event_log (errors_only=false): показывает и информационные события, и ошибки', allOut);

  // 3.2 Проверяем текстовый формат Журнала регистрации (1Cv8.lgf + *.lgp)
  const txtLogDir = join(root, 'build', 'txtlog');
  mkdirSync(txtLogDir, { recursive: true });
  writeFileSync(join(txtLogDir, '1Cv8.lgf'), `{1,"0000-0001","Иванов",1}\n{3,"1CV8C","Тонкий клиент",1}\n{4,"_$PerformError$_","Ошибка выполнения",2}\n`);
  writeFileSync(join(txtLogDir, '20261024220000.lgp'),
    `{20261024223500,R,{0,0},1,1,1,5,2,E,"{ОбщийМодуль.ПродажиСервер.Модуль(3)}: Сумма не может быть отрицательной",0,{"U"},""}\n`);

  const lgpOut = await readEventLog(idx, { log_path: txtLogDir });
  ok(/2026-10-24 22:35:00/.test(lgpOut) &&
     /Иванов/.test(lgpOut) &&
     /Файл в проекте: src\/cf\/CommonModules\/ПродажиСервер\/Ext\/Module\.bsl:3 \(Процедура КонтрольЛимитаПередЗаписью\)/.test(lgpOut),
     'event_log (текстовый .lgp + .lgf): разбирает словарь .lgf, запись .lgp и находит строку в общем модуле', lgpOut);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

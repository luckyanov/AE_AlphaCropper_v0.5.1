# Alpha Smart Cropper for Adobe After Effects

[English](README_EN.md) · [Русский](README_RU.md)

**Текущая версия: 0.5.0**

Alpha Smart Cropper — JSX-скрипт для автоматической обрезки прекомпозиций After Effects по **фактически отрендеренному альфа-каналу**, а не по геометрическому размеру слоёв.

Главный сценарий — импорт из Photoshop, когда слой визуально занимает маленькую область, но сам слой имеет размер всей композиции. Обычный `sourceRectAtTime()` в таком случае может вернуть практически весь холст, хотя большая его часть полностью прозрачна.

Скрипт отлично подходит для адаптации слоёв, полученных из файлов Photoshop (`PSD`): он уменьшает их фактические размеры до области видимого содержимого и тем самым может сократить объём обрабатываемых пикселей и время рендера.

Скрипт ищет первый/последний пиксель с ненулевой альфой, уменьшает размер исходной прекомпозиции и компенсирует координаты так, чтобы изображение осталось на прежнем месте во всех родительских композициях.

---

## Что умеет

- Обрезает прекомпозицию по **реальному rendered alpha**.
- Пиксели с `alpha = 0` считаются пустыми независимо от исходного размера PSD/PNG/footage layer.
- Может учитывать всю анимацию покадрово.
- Может анализировать только source-time, который реально используется экземплярами прекомпозиции.
- Учитывает:
  - `In Point` / `Out Point`;
  - `Start Time`;
  - `Stretch`, включая отрицательный;
  - `Time Remap`;
  - Frame Blending с дополнительными соседними source-сэмплами.
- Автоматически сокращает анализ до одного кадра, если композиция доказуемо статична.
- Для композиций, где меняется только `In/Out` статичных слоёв, анализирует только уникальные состояния видимости, а не каждый кадр.
- Распознаёт как статические:
  - still footage;
  - solids;
  - рекурсивно статические precomp;
  - обычный статический Text Layer без Text Animators;
  - статический Shape Layer без анимации и без Wiggle-подобных операторов.
- Поддерживает рекурсивную обрезку вложенных прекомпозиций снизу вверх.
- Позволяет выбрать одну или несколько композиций прямо в Project panel; для такого запуска рекурсивная обработка вложенных прекомпозиций включается по умолчанию.
- В режиме `Recursive + Selected Layers` протягивает реально используемый диапазон времени вниз по цепочке nested precomp.
- Сохраняет положение **всех usages** изменяемой прекомпозиции в проекте.
- Поддерживает произвольную глубину 2D-parent chain.
- Поддерживает `Collapse Transformations` для 2D usage.
- Сохраняет положение непосредственных дочерних слоёв usage.
- Компенсирует Mask Path на usage-слое.
- Поддерживает обычный и Separated Dimensions Position.
- Поддерживает статические и keyframed Position/Anchor Point там, где постоянное смещение математически безопасно.
- По умолчанию помещает Anchor Point полученной прекомпозиции в её центр, сохраняя изображение на месте компенсацией через Position; функцию можно отключить.
- Есть Padding.
- Есть `Dry Run`.
- Есть пресеты `Current Frame / Safe Animation / Selected Branch`.
- Последние настройки сохраняются между запусками через `app.settings`.
- Длительный анализ можно остановить кнопкой `Stop analysis`.
- Project-wide режим сначала анализирует все композиции и показывает сводку, а изменения применяет только после отдельного подтверждения.
- Весь проект индексируется по usages один раз за запуск, что особенно важно при рекурсивной обработке больших проектов.
- Внутри alpha analyzer используется кэш повторных прямоугольных `sampleImage()` запросов.

---

## Почему обычный crop может не работать с PSD

После импорта Photoshop слой нередко выглядит примерно так:

```text
1920 × 1920 layer
┌──────────────────────────────────────┐
│                                      │
│                                      │
│                █████                 │
│                █foto                 │
│                █████                 │
│                                      │
│                                      │
└──────────────────────────────────────┘
```

Геометрически слой остаётся `1920×1920`, поэтому crop по layer bounds не видит пустого пространства.

Alpha Smart Cropper анализирует итоговый рендер:

```text
alpha = 0    → пусто
alpha > 0    → содержимое
```

и получает, например:

```text
alpha bounds: [938, 980] .. [1353, 1444]
result:       416 × 465
```

---

## Установка

### Быстрый запуск

В After Effects:

```text
File → Scripts → Run Script File...
```

и выбрать:

```text
AlphaSmartCropper_v0.5.0.jsx
```

### Постоянная установка

Скопировать JSX в папку Scripts установленной версии After Effects, после чего перезапустить AE.

Для обычного запуска через меню ScriptUI Panel не требуется: текущая версия открывает собственное диалоговое окно.

---

## Базовое использование

1. Открыть родительскую композицию.
2. Выделить один или несколько **precomp layers**.
3. Запустить `AlphaSmartCropper_v0.5.0.jsx`.
4. Выбрать режим анализа.
5. Первый запуск на новом типе проекта лучше выполнять с `Analyze only (Dry Run)`.
6. Проверить отчёт.
7. Выключить Dry Run и выполнить реальный crop.

Вся фактическая модификация помещается в один Undo Group.

### Выбор композиции прямо в Project panel

Вместо выделения precomp layer можно выбрать одну или несколько композиций непосредственно в панели Project и запустить скрипт. В этом режиме опция `Recursively crop nested precomps first` включена по умолчанию: сначала обрабатываются самые глубокие вложенные композиции, затем выбранная корневая композиция. При стандартном режиме `Current frame only` время выбранной корневой композиции корректно протягивается через In/Out, Start Time, Stretch и Time Remap во вложенную ветку.

Если одновременно в активной композиции выделены precomp layers, приоритет имеет выбор слоёв. Чтобы обработать именно Project-panel selection, снимите выделение с precomp layers.

Режим `Used source frames — selected layers in active comp` для Project-panel selection недоступен, поскольку у такого запуска нет выбранных usage-слоёв.

---

# Пресеты и сохранение настроек

В верхней части окна доступны пресеты:

- `Current Frame` — один текущий кадр, `Frame step = 1`, статическая оптимизация включена.
- `Safe Animation` — весь source timeline покадрово с консервативной статической оптимизацией.
- `Selected Branch` — реально используемые кадры выделенных precomp layers с включённым Recursive Crop.

`Selected Branch` доступен только при выборе precomp layers в активной композиции. Пресеты меняют параметры временного анализа, но не включают и не выключают project-wide scope. После применения пресета отдельные параметры можно изменить вручную.

Последние принятые настройки сохраняются средствами `app.settings` и восстанавливаются при следующем запуске. На первой установке `Current frame only` и центрирование Anchor Point включены по умолчанию.

---

# Режимы анализа времени

По умолчанию выбран `Current frame only`. Это делает обычный запуск быстрым и предсказуемым; для анимированных композиций необходимо явно выбрать анализ всего диапазона или реально используемых source frames.

## 1. Entire source composition — every frame

Самый прямолинейный режим.

Проверяется весь таймлайн source comp.

```text
source: 0 ───────────────────────── 60 sec
        ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑
        все кадры
```

При `Frame step = 1` это наиболее консервативный вариант для самостоятельно используемой анимированной композиции.

Автоматическая статическая оптимизация всё равно может сократить такой анализ до одного кадра или нескольких visibility states.

---

## 2. Used source frames — all project usages

**Рекомендуемый режим по умолчанию.**

Скрипт находит все usages этой source comp во всём проекте и анализирует только source-times, которые реально запрашиваются родительскими композициями.

Пример:

```text
source comp: 60 sec

MAIN / LIAM
uses source 12–18 sec

SECOND COMP / LIAM
uses source 30–34 sec
```

Будут проверяться нужные source-times этих двух usages вместо всех 60 секунд.

Это хороший баланс между скоростью и безопасностью, потому что одна source comp изменяется глобально и все её usages должны оставаться корректными.

Если на usage есть Effect Stack, который потенциально может менять временную выборку (`Echo`, `Timewarp`, некоторые сторонние плагины и т. п.), режим консервативно возвращается к полному source timeline.

---

## 3. Used source frames — selected layers in active comp

Самый агрессивный режим.

Анализируется только source-time, реально используемый **выделенными экземплярами** прекомпозиции в активной композиции.

Это полезно, если длинный source содержит материал, который в данном монтажном контексте никогда не используется.

Важно: source comp всё равно изменяется глобально. Если та же прекомпозиция используется в другом месте проекта и там задействована другая часть её анимации, выбранный режим может обрезать эту часть.

Скрипт выводит предупреждение, если выбранные usages не покрывают все usages source comp в проекте.

---

## 4. Work area — every frame

Анализируется Work Area самой source composition.

Полезно для ручного ограничения диапазона без привязки к usages.

---

## 5. Current frame only

Проверяется только текущий source frame.

Использовать для гарантированно статичного кадра или сознательной одно-кадровой обрезки.

Для анимации этот режим может отрезать пиксели, которые появляются позже.

---

# Frame step

```text
1 = каждый запрошенный кадр
2 = каждый второй
3 = каждый третий
...
```

`Frame step = 1` — рекомендуемое значение.

Значения `> 1` ускоряют динамический анализ, но могут пропустить экстремальное положение объекта между проверенными кадрами.

Скрипт всегда добавляет последний кадр запрошенного интервала, но это не превращает coarse sampling в математически точный анализ.

---

# Автоматическая временная оптимизация

Опция:

```text
[x] Auto: optimize static / visibility-only timelines
```

## Полностью статичная композиция

Если скрипт может консервативно доказать, что результат не меняется со временем:

```text
1770 candidate frames
        ↓
1 rendered-alpha frame
```

Проверка смотрит не только на Position. Учитываются time-varying свойства всего visual property tree.

Наличие keyframe или enabled expression на визуально значимом свойстве заставляет скрипт считать композицию динамической.

## Только изменения видимости In/Out

Если сами изображения/трансформации статичны, но слои появляются и исчезают из-за In/Out:

```text
1770 frames
        ↓
state A: layers 1,2,3 visible
state B: layers 1,3 visible
state C: layers 1,4 visible
        ↓
3 rendered-alpha frames
```

Это точная оптимизация для классифицированного случая: если содержимое слоёв не меняется, одинаковый набор активных слоёв даёт одинаковый rendered result.

---

# Recursive Crop

Опция:

```text
[ ] Recursively crop nested precomps first
```

Для дерева:

```text
A
└── B
    └── C
        └── D
```

порядок обработки:

```text
D → C → B → A
```

Именно такой порядок нужен, чтобы внешний comp анализировался уже после оптимизации внутренних, при этом визуальное положение внутренних precomp компенсируется перед обработкой родителя.

Shared nested comps обрабатываются один раз.

## Recursive + Selected Layers

В версии 0.4 диапазон времени выбранной ветки протягивается вниз.

Условно:

```text
MAIN
└── CHARACTER          используется 10–15 sec
    └── HEAD           реально 2–7 sec source time
        └── MOUTH      реально 0.5–2.1 sec source time
```

Скрипт не обязан анализировать полный таймлайн `HEAD` и `MOUTH`: он строит union source-times, которые реально достижимы от выбранного parent usage.

Если на nested usage есть эффекты, потенциально меняющие temporal sampling, для соответствующей вложенной comp включается full-timeline fallback.

### Важное предупреждение

`Selected Layers + Recursive` намеренно оптимизирует **выбранную ветку**, а не весь проект.

Если shared nested comp используется ещё где-то с другим диапазоном анимации, этот режим может обрезать данные, нужные тому usage.

Для максимальной сохранности shared comps использовать:

```text
Used source frames — all project usages
```

---

# Как сохраняется положение прекомпозиции

Пусть найденный crop origin:

```text
cropLeft = X
cropTop  = Y
```

Внутри source comp корневые слои получают:

```text
Position += [-X, -Y]
```

У каждого usage source comp компенсируется Anchor Point тем же локальным смещением:

```text
Anchor Point += [-X, -Y]
```

За счёт этого старый source pixel сохраняет то же визуальное положение в parent comp даже через цепочку 2D-родителей с Position / Scale / Rotation.

Скрипту не требуется вручную пересчитывать каждый parent-to-world transform.

---

# Direct children

Опция:

```text
[x] Preserve direct children of every precomp usage
```

Если usage сам является родителем:

```text
PRECOMP
├── Text
├── Icon
└── Null
```

изменение Anchor Point PRECOMP сдвинуло бы его детей.

Поэтому их Position получает компенсирующий локальный offset.

Expression-driven Position непосредственного ребёнка автоматически не переписывается: такой кейс считается небезопасным и crop пропускается.

---

# Центрирование Anchor Point через Position

Опция:

```text
[x] Center resulting precomp Anchor Point (via Position)
```

В версии 0.5.0 опция включена по умолчанию, поскольку центрированный Anchor Point удобнее для дальнейшей анимации. При необходимости её можно отключить и вернуться к наиболее универсальной компенсации через Anchor Point, поддерживающей анимированные 2D-трансформации и 2D Collapse Transformations.

Если опция включена, после crop каждый usage получает:

```text
Anchor Point = [newWidth / 2, newHeight / 2]
Position    += transformed compensation
```

Это удобно для дальнейшей ручной анимации и выравнивания. Чтобы не допустить визуального сдвига, скрипт пропускает исходную композицию, если хотя бы один usage использует 3D, Collapse Transformations, анимированный Anchor Point / Scale / Rotation, ненулевой Skew или expression-driven трансформацию, необходимую для компенсации. Статический Scale и Rotation учитываются при расчёте смещения Position. Анимированный Position поддерживается, поскольку к его значениям добавляется постоянный безопасный offset.

---

# Collapse Transformations

Поддерживается:

```text
2D Precomp Layer
Collapse Transformations = ON
```

при включённой настройке:

```text
[x] Allow 2D Collapse Transformations usages
```

Не поддерживается:

```text
3D Precomp Layer + Collapse Transformations
```

В 3D collapsed pipeline внутренние 3D transforms взаимодействуют с камерой/светом родительской композиции, и простая 2D-компенсация уже не является общей гарантией.

---

# Padding

```text
Padding = 0
```

обрезает непосредственно по найденной альфе.

```text
Padding = 20
```

оставляет 20 px запаса вокруг union alpha bounds.

Padding особенно полезен для дальнейших эффектов, которые могут быть добавлены после crop.

---

# Alpha epsilon

По умолчанию:

```text
Alpha epsilon = 0
```

Это означает: любой обнаруженный ненулевой alpha считается содержимым.

Внутренне `sampleImage()` возвращает среднюю альфу прямоугольника. Скрипт умножает её на площадь sampled rectangle и использует полученную alpha sum для бинарного поиска.

Поэтому при `epsilon = 0` бинарный поиск отвечает на вопрос:

```text
есть ли в этом прямоугольнике хотя бы ненулевая альфа?
```

Положительный epsilon можно использовать против почти невидимого alpha noise, но это уже сознательное ослабление строгого правила `alpha > 0`.

---

# Dry Run

Рекомендуется для первого запуска на новом проекте:

```text
[x] Analyze only (Dry Run)
```

Скрипт выполняет анализ, но не изменяет проект.

Пример отчёта:

```text
INFO LIAM: static alpha proven; reduced 1770 candidate frame(s) to 1 rendered-alpha frame.
DRY  LIAM: 1920x1920 -> 416x465,
     crop origin [938, 980],
     alpha bounds [938, 980]..[1353, 1444],
     1 frame(s) from 1770 candidate frame(s),
     scan=all usage frames,
     sampleImage=...
```

---

# Project-wide preview и остановка анализа

Опция:

```text
[ ] Project-wide preview, then apply all safe crops
```

собирает все композиции проекта, сортирует их deepest-first и выполняет полный Dry Run. После этого открывается общая сводка. `Apply Crops` запускает второй анализ и применяет только безопасные операции; `Cancel` оставляет проект без crop-изменений.

Второй проход намеренно анализирует композиции заново, чтобы учитывать изменения вложенных прекомпозиций и dimension-dependent expressions. Поэтому режим может быть заметно дольше обычного запуска.

В окне прогресса доступна кнопка `Stop analysis`. Остановка происходит после анализа текущего кадра. Если остановлен apply-pass, уже обработанные композиции остаются изменёнными, но весь проход находится в одном Undo Group.

Project-wide preview можно запустить даже без предварительно выделенных слоёв или композиций.

---

# Что считается небезопасным

Скрипт намеренно предпочитает `SKIP`, если не может гарантировать сохранение результата.

К основным ограничениям относятся:

- 3D layers внутри source comp;
- Camera / Light внутри source comp;
- collapsed 3D usage;
- expression-driven Anchor Point у usage;
- expression-driven Position у корневого source layer, который нужно физически сместить;
- expression-driven Position у direct child при включённом Preserve Children;
- expression-driven Mask Path на usage;
- Essential Properties на usage — по умолчанию;
- Solo в source comp — по умолчанию;
- некоторые coordinate/dimension-dependent expressions могут изменить результат после resize.

---

# Essential Properties

По умолчанию включено:

```text
[x] Skip usages with Essential Properties (recommended)
```

Причина принципиальная.

Одна source comp может иметь несколько instances:

```text
CHARACTER instance A → Essential Property X = 100
CHARACTER instance B → Essential Property X = 900
```

Source-only alpha analyzer видит исходное состояние композиции, но не все instance-specific overrides одновременно.

Пока такой случай пропускается.

Планируемая будущая реализация — отдельный alpha analysis каждого instance с union bounds по всем overrides.

---

# Effects

Эффекты **внутри source comp** входят в итоговый rendered alpha, потому что анализируется финальный результат композиции.

Однако эффекты на самом usage-слое в родительской композиции могут хранить layer-space координаты. После изменения размера source эти координаты не всегда можно универсально пересчитать для любого стороннего эффекта.

Доступна опция:

```text
[ ] Skip usages with effects (strict safety)
```

Если выключена, crop разрешается, но в отчёте выводится предупреждение.

Кроме того, usage effects заставляют режим `Used source frames — all project usages` отказаться от temporal-range optimization, потому что некоторые эффекты могут читать соседние/другие моменты времени.

---

# Expressions, зависящие от размеров композиции

Скрипт ищет выражения, содержащие конструкции наподобие:

```javascript
thisComp.width
thisComp.height
thisLayer.width
thisLayer.height
source.width
source.height
sourceRectAtTime(...)
```

и выводит предупреждение.

Например:

```javascript
[thisComp.width / 2, thisComp.height / 2]
```

по определению изменит своё значение после resize композиции.

Универсально сохранить семантику произвольного expression при изменении `comp.width/height` невозможно без разбора самого выражения.

---

# Производительность

Самая дорогая операция — evaluation `sampleImage()` через expression engine AE.

Версия 0.4 использует несколько уровней оптимизации:

1. **Project Usage Index** — список usages всех precomp строится один раз за запуск.
2. **Temporal classification memo** — статичность вложенных comp не пересчитывается многократно.
3. **Static one-frame scan** — полностью статичная comp анализируется один раз.
4. **Visibility-state scan** — статичная геометрия с меняющимися In/Out анализируется по уникальным состояниям.
5. **Used-source-time scan** — неиспользуемая часть таймлайна не проверяется.
6. **Recursive selected-time propagation** — nested comps получают только достижимые source-times выбранной ветки.
7. **Rectangle alpha cache** — повторный identical `sampleImage()` query в рамках одного analyzer не пересчитывается.
8. После обнаружения глобальных bounds следующий кадр сначала проверяет только области **за пределами уже найденного bounding box**. Полный бинарный поиск выполняется лишь если новый кадр действительно расширяет границу.

Последний пункт особенно важен для длинной анимации, которая двигается внутри уже найденной общей области.

---

# Отчёт

Типы строк:

```text
INFO  информационное решение/оптимизация
WARN  операция выполнена, но существует оговорка
SKIP  композиция сознательно не изменена
DRY   результат анализа без изменения проекта
OK    crop выполнен либо comp уже была tight
ERROR непредвиденная ошибка
```

Для диагностики полезны поля:

```text
frame(s)
ms
scan=...
sampleImage=...
cacheHits=...
```

Если найден баг, лучше присылать всю строку `SKIP / WARN / ERROR`, а не только номер ошибки.

---

# Рекомендуемые настройки

## Обычный безопасный рабочий режим

```text
Scan: Current frame only для статичного кадра;
      Used source frames — all project usages для анимации
Frame step: 1
Auto temporal optimization: ON
Padding: 0
Alpha epsilon: 0
Preserve direct children: ON
Center resulting Anchor Point: ON
Allow 2D Collapse Transformations: ON
Skip Solo source comps: ON
Skip usages with effects: OFF
Skip Essential Properties: ON
Recursive Crop: OFF или ON по задаче
Dry Run: первый запуск ON
```

## Быстрая оптимизация конкретной ветки мастер-композиции

```text
Scan: Used source frames — selected layers in active comp
Frame step: 1
Auto temporal optimization: ON
Recursive Crop: ON
```

Использовать только когда допустимо игнорировать временные диапазоны shared precomps, которые задействованы в других ветках проекта.

---

# Что проверить после crop

Для серьёзного проекта рекомендуется быстро пройтись по следующим кейсам:

- текущий master frame до/после визуально совпадает;
- начало и конец каждого используемого фрагмента;
- кадры вокруг Position/Scale/Rotation keyframes;
- Time Remap extremes;
- usages с Collapse Transformations;
- дети, привязанные непосредственно к cropped precomp;
- masks на usage;
- effects на usage;
- expressions с `thisComp.width/height`;
- shared precomps в других композициях;
- recursive branch при selected-usage scan.

И, разумеется, перед первым массовым запуском лучше иметь сохранённую версию `.aep`. Undo — хороший парашют, но резервная копия ещё ни разу не жаловалась на лишнюю работу.

---

# Известные ограничения 0.5.0

1. **3D source comps не поддерживаются.**
2. **Collapsed 3D usages не поддерживаются.**
3. **Essential Properties per-instance bounds пока не анализируются.**
4. **Temporal effects невозможно универсально классифицировать**, поэтому используется консервативный fallback.
5. Plain Text/Shape поддерживаются статическим анализом, но Text Animators и Wiggle-подобные Shape operators переводят comp в dynamic mode.
6. Coordinate-dependent expressions могут изменить результат при смене comp size.
7. `Frame step > 1` не гарантирует захват промежуточных экстремумов.
8. Selected-usage mode по определению может игнорировать данные, используемые другими instances той же source comp.
9. Точная поддержка нестандартного `displayStartTime`/сложных subframe temporal effects требует дополнительного тестирования в AE.
10. Опциональное центрирование Anchor Point через Position намеренно ограничено безопасными 2D usages со статическими Scale/Rotation и без Collapse Transformations.

---

# Roadmap

Наиболее полезные следующие шаги:

### 0.6 — Safety + instance-aware analysis

- анализ Essential Properties по каждому instance;
- более точная классификация temporal / non-temporal Effects вместо fallback по наличию любого effect stack;
- строгий режим для coordinate-dependent expressions;
- отдельная диагностика `toComp/fromComp/toWorld/fromWorld` expressions.

### 0.7 — Partial-static renderer

Разделение композиции на:

```text
static base bounds
+
dynamic layers bounds
```

чтобы не рендерить всю сложную статическую PSD-часть на каждом кадре одной маленькой анимации.

Реализовывать это нужно только для доказуемо безопасных stacking/matte/blending случаев; иначе оптимизация будет быстрее ровно до первого отрезанного уха.

### 0.8 — Precomp Optimizer

Режим массового анализа ветки/проекта:

```text
47 comps checked
31 cropped
10 already tight
4 unsafe
2 empty
```

с возможностью сначала выполнить project-wide Dry Run, а затем применить только безопасный набор.

### UI / workflow

- пресеты `Safe / Balanced / Aggressive`;
- сохранение пользовательских настроек;
- отдельная ScriptUI Panel;
- экспорт отчёта в `.txt`;
- optional per-side padding;
- фильтрация по минимальному выигрышу размера/площади.

---

# История версий

## 0.5.0

- Центрирование Anchor Point включено по умолчанию.
- Добавлено сохранение последних настроек через `app.settings`.
- Добавлены пресеты `Current Frame / Safe Animation / Selected Branch`.
- Добавлена кнопка остановки длительного анализа.
- Добавлен двухпроходный project-wide preview со сводкой и отдельным подтверждением применения.
- Project-wide режим можно запускать без предварительного выбора crop roots.
- JSX переименован в `AlphaSmartCropper_v0.5.0.jsx`.

## 0.4.0

- Режимом анализа по умолчанию сделан `Current frame only`.
- Добавлен выбор композиций непосредственно в Project panel с включённой по умолчанию рекурсивной обработкой.
- Кнопки `Crop` и `Cancel` разнесены по противоположным сторонам окна.
- Добавлен опциональный безопасный режим центрирования Anchor Point через компенсацию Position.
- Добавлена рекурсивная передача selected usage source-times вниз по nested branch.
- Добавлен единый project usage index.
- Добавлен memoized temporal classification.
- Добавлена оптимизация композиций, где меняется только In/Out статичного содержимого.
- Статический анализ теперь поддерживает обычный Text Layer без Text Animators.
- Статический анализ теперь поддерживает безопасные static Shape Layers.
- Добавлен cache одинаковых rectangle alpha queries.
- В отчёт добавлено количество фактических `sampleImage()` evaluations.
- Полностью включён alpha-analyzer в самодостаточный JSX.

## 0.3.0

- Used source frames modes.
- Conservative one-frame static optimization.
- Recursive crop.
- Frame Blending neighbors.
- Essential Properties safety check.
- Track Matte awareness в static proof.

## 0.2.0

- Разрешён 2D Collapse Transformations.
- Collapsed 3D usage оставлен заблокированным.

## 0.1.x

- Rendered-alpha crop через `sampleImage()`.
- Компенсация usages, children и masks.
- Padding / Dry Run.

---

# Статус тестирования

JSX проходит синтаксическую проверку как JavaScript-файл, но полноценный integration test требует запуска внутри Adobe After Effects, поскольку `CompItem`, `AVLayer`, `sampleImage()`, ScriptUI и expression evaluation предоставляются самим AE.

Поэтому при обнаружении проблемы полезнее всего сохранить минимальный воспроизводимый кейс и прислать:

```text
версия After Effects
строка INFO/WARN/SKIP/ERROR
структура parent/precomp
2D/3D
Collapse Transformations
есть ли Time Remap / effects / expressions / masks
```

Это позволит чинить конкретную ветку логики, а не устраивать шаманство вокруг `sourceRectAtTime()`.

# Замеры обнаружения: что видят страницы и серверы

Матрица от 2026-10-31 и шесть прогонов на финальном дереве от 2026-11-01, см. [ниже](#повтор-на-финальном-дереве-2026-11-01). Потом, тем же днём, правки окружения и персон Linux, с замерами: [ниже](#окружение-и-персоны-linux-2026-11-01-вечер). CloakBrowser 146.0.7680.177.5, Camoufox 152.0.4-beta.30. Машина: Windows 11, один экран 1920×1080, Docker Desktop. Linux здесь значит образ `docker build --target baseline`: Debian bookworm, Node 22, seccomp из `docker/seccomp-chromium.json`, sandbox включён.

## Итог: «на сервере не хуже, чем на десктопе»

**Это верно только на Windows. На Linux в Docker это неверно ни для одного движка и режима**, и после правок окружения от 2026-11-01 тоже: разрыв меньше, но не закрыт. JA4, HTTP/2, порядок заголовков и события ввода одинаковые во всех режимах и на обеих ОС. Отличается то, что читают скрипты страницы: шрифты, аудио, устройства, WebGL.

Эталон сравнения: окно на Windows с запуском как у десктопа (без моста, без обработки перекрытия, с расширением-компаньоном), `win-headed-desktop-*`. Сервер в этих строках запущен как в продакшене: `--egress block-private`, исключения только для локальных страниц.

| Движок | Режим | Не хуже десктопа? | Чем отличается от десктопа |
| --- | --- | --- | --- |
| CloakBrowser | Windows, окно | **Да, с одной оговоркой** | `connection.rtt` 0 и `downlink` 10 из-за моста |
| CloakBrowser | Windows, headless | **Да, с оговорками** | то же, плюс `colorDepth` 24 вместо 32 и нет `any-pointer: coarse` при `maxTouchPoints` 10 |
| CloakBrowser | Linux, Xvfb, Windows-персона | **Нет** | 52 из 57 шрифтов Windows нет (было 54), другой эмодзи, нет камеры, 2 канала звука вместо 8, плюс `rtt` |
| CloakBrowser | Linux, Xvfb, Linux-персона | **Нет** | CreepJS «похоже на headless» 38 % против 19 % (было 50 %), остальное то, что даёт Chrome на любом Linux. GPU с оценкой A (был F), но у NVIDIA и AMD CreepJS пишет `suspicious gpu` и `suspicious capabilities`, у Intel нет. Нет камеры, плюс `rtt` |
| CloakBrowser | Linux, headless | **Нет, и хуже Xvfb** | всё из строки Xvfb, плюс другой canvas, 33 расширения WebGL вместо 35, у Windows-персоны CreepJS: `suspicious gpu`, `suspicious capabilities` |
| Camoufox | Windows, окно и headless | **Да, кроме WebRTC** | `RTCPeerConnection` отсутствует совсем и минус 22 глобальных имени (`RTC*`, `WebTransport*`): так работает блокировка на мосту |
| Camoufox | Linux, Xvfb | **Нет** | 0 голосов, нет камеры, 2 канала звука вместо 8 (было 44100 Гц, 0 каналов и ни одного устройства), нет `GPU*` и `Touch*` (44 имени), плюс WebRTC |
| Camoufox | Linux, headless | **Нет, и заметно хуже Xvfb** | всё из строки Xvfb, и **WebGL нет вообще** |

Строки Linux здесь на образе и дереве после правок окружения и персон, прогоны `2026-11-01-linux-*-session-*`. Что было до них, в скобках, и сравнения со старыми прогонами: в разделе [об окружении](#окружение-и-персоны-linux-2026-11-01-вечер). Строки Windows от правок не зависят: те меняют только образ и персоны Linux.

`HeadlessChrome`, `webdriver: true` и `pointer: none` не сработали ни в одном из 48 прогонов. Папок прогонов здесь 55: 48 из матрицы, `2026-10-31-before-worker-fix-win-headless-cb`, снятый до исправления worker (см. ниже) и в итог не входящий, и шесть `2026-11-01-*` из повтора. В них эти признаки тоже не сработали.

### Вердикты CreepJS и rebrowser-bot-detector

CreepJS: «похоже на headless» / «headless» / «stealth», %. Ложь и мусор: сколько записей он нашёл. rebrowser: сам по себе, то есть пока агент ничего не вызывал, и после `extract` и `evaluate_js`.

| Прогон | CreepJS % | Ложь | Мусор | rebrowser сам по себе | rebrowser после вызовов агента |
| --- | --- | --- | --- | --- | --- |
| `win-headed-desktop-cb` (десктоп) | 19 / 0 / 0 | 5 | 2 | чисто | красный `mainWorldExecution` |
| `win-headed-server-cb` | 19 / 0 / 0 | 5 | 2 | чисто | то же |
| `win-headless-server-cb` | 19 / 0 / 0 | 5 | 2 | чисто | то же |
| `linux-xvfb-server-cb` | 25 / 0 / 0 | 5 | 2 | чисто | то же |
| `linux-headless-server-cb` | 25 / 0 / 0 | 5 | **4** | чисто | то же |
| `linux-xvfb-linuxpersona-cb` | **50** / 0 / 0 | 5 | 3 | чисто | то же |
| `linux-headless-linuxpersona-cb` | **50** / 0 / 0 | 5 | **4** | чисто | то же |
| `linux-xvfb-server-session-cb`, после правок | 25 / 0 / 0 | 5 | 2 | чисто | то же |
| `linux-headless-server-session-cb` | 25 / 0 / 0 | 5 | **4** | чисто | то же |
| `linux-xvfb-linuxpersona-session-cb` (NVIDIA) | **38** / 0 / 0 | 5 | **4** | чисто | то же |
| `linux-headless-linuxpersona-session-cb` (NVIDIA) | **38** / 0 / 0 | 5 | **4** | чисто | то же |
| `linux-xvfb-intelpersona-session-cb` | **38** / 0 / 0 | 5 | 2 | чисто | то же |
| `linux-xvfb-amdpersona-session-cb` | **38** / 0 / 0 | 5 | **4** | чисто | то же |
| `win-headed-desktop-cf` (десктоп) | 6 / 0 / 0 | 0 | 0 | красный `ipcFloodingProtection`, жёлтые `popupBlocking`, `viewport` | то же |
| `win-headed-server-cf`, `win-headless-server-cf` | 6 / 0 / 0 | 0 | 0 | то же | то же |
| `linux-xvfb-server-cf`, `linux-headless-server-cf` | 6 / 0 / 0 | 0 | 0 | то же | то же |
| `linux-*-session-cf`, после правок, все восемь | 6 / 0 / 0, раз 13 | 0 | 0 | то же | то же |

Мусор 4 вместо 2 у CloakBrowser это `suspicious gpu` и `suspicious capabilities` от WebGL, остальные два `AudioBuffer`. 13 у Camoufox в одном прогоне из восьми: он сам вытянул `availHeight`, равный высоте экрана (`noTaskbar`), в повторе 6.

Как читать 19 и 25: разница только в `prefersLightColor`. На этой машине Windows в тёмной теме, а в контейнере светлая. На Windows со светлой темой десктоп дал бы те же 25. Ложь у CloakBrowser (`AudioBuffer`, `getImageData`, `getClientRects`) и мусор `AudioBuffer` есть и на десктопе: это его собственный шум отпечатка, на режим он не реагирует.

## Повтор на финальном дереве (2026-11-01)

После матрицы код менялся дважды, по итогам двух проверок. Снято заново подмножество с теми же сидом и устройством (`mz-baseline-70`, `windows-desktop-nvidia`), теми же версиями движков, и каждый прогон сравнен с сохранённым: `compare.ts` с `-2` от 2026-10-31 как `--repeat`. Десктопный эталон снят без `--raise` и без `--cover-test`, чтобы не мешать работать за машиной.

| Прогон | Отличий от сохранённого | Что это |
| --- | --- | --- |
| `win-headless-server-cb` | 0 | |
| `linux-xvfb-server-cb` | 0 | |
| `linux-headless-server-cb` | 0 | |
| `linux-xvfb-server-cf` | 2 | `input.click.sequence` (указатель прошёл ещё над одним элементом) и `creepjs.audio.totalUniqueSamples` 4734 вместо 4735 и 4736. В повторе `linux-xvfb-server-2-cf` оба значения вернулись к сохранённым, зато выпала другая видеокарта, Intel вместо NVIDIA: 9 отличий, все про неё. Это отпечаток, который Camoufox разыгрывает при каждом запуске, а не изменение кода |
| `win-headed-desktop-cb` | 34 | Все от того, что окно без `--raise` открылось позади других и ни разу не отрисовалось: `visibilityState` `hidden`, нет записей о paint и кадров анимации, `hasFocus` false, `outerWidth` и `outerHeight` 0, а `click` падает с `INPUT_NOT_DELIVERED`. Заголовки, шрифты, TLS, HTTP/2, WebRTC, CreepJS и rebrowser: 0 отличий. Это та же история про перекрытое окно, что ниже в «Открытых вопросах», только с рождения окна |

**Дрейфа в том, что видит детектор, нет.** Итог выше относится к финальному дереву: сохранённый десктоп против новых серверных прогонов даёт те же числа отличий, что и сохранённые сравнения: `win-headless-server-cb` 11, `linux-xvfb-server-cb` 110, `linux-headless-server-cb` 123, `linux-xvfb-server-cf` 53. Строки итога без нового прогона (`win-headed-server`, Camoufox на Windows, Linux-персоны) стоят на матрице 2026-10-31. Файлы сравнений: `compare-2026-10-31-*-vs-2026-11-01-*.md`, `compare-2026-11-01-linux-xvfb-server-cf-vs-2026-11-01-linux-xvfb-server-2-cf.md`.

Без `--raise` страница десктопного прогона скрыта, поэтому для сравнения окна с окном он не годится: эталоном остаётся `2026-10-31-win-headed-desktop-*`.

## Что нашли и исправили по дороге

**В этой ветке на CloakBrowser не запускался ни один Web Worker.** Не в вышедшей 0.10.0, а в незавершённой работе этой ветки, и на десктопе тоже. `CdpSession` просил `Target.setAutoAttach` с `waitForDebuggerOnStart: true` и фильтром `page` и `iframe`. Chromium ставит на паузу новый worker при любом фильтре, но к исключённому фильтром не подключается, и снять его с паузы некому. Замер на голом бинаре, в миллисекундах до ответа:

| Автоподключение | Обычный | Blob | Вложенный | В OOPIF | Shared | Service | SW расширения |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Его нет | 17 | 17 | 29 | 29 | 19 | 30 | запустился |
| С фильтрами, как было | **никогда** | **никогда** | **никогда** | **никогда** | **никогда** | **никогда** | **нет** |
| Без фильтра, как теперь | 18 | 18 | 33 | 33 | 18 | 33 | запустился |

Сайты с worker просто ломались бы, и детектор это видит сразу: `rebrowser workerConsistency` давал таймаут, а CreepJS не мог снять `workerScope`. Исправление: фильтра нет ни на одном уровне, всё, что не вкладка и не фрейм, снимается с паузы и отключается при подключении. Прогон до исправления лежит в `2026-10-31-before-worker-fix-win-headless-cb`, все остальные сделаны после.

## Что это за прогоны

Все с одной персоной `--seed mz-baseline-70 --device windows-desktop-nvidia` (1920×1080, en-IE, Europe/Dublin), кроме `-linuxpersona`: там персона, которую `create_profile` выбирает на Linux сам (`linux-laptop-nvidia`, 2560×1440). `-cb` значит CloakBrowser, `-cf` значит Camoufox.

| Прогон | Где | Что это |
| --- | --- | --- |
| `win-headed-desktop-*`, `-2` | Windows | **Десктоп, эталон.** Окно, запуск как у десктопа. `-2` тот же запуск ещё раз, чтобы видеть шум |
| `win-headed-occlusion-*` | Windows | Он же плюс обработка перекрытия окна от сервера |
| `win-headed-server-*`, `-2` | Windows | Сервер с окном: мост и обработка перекрытия |
| `win-headless-*`, `-2` | Windows | Headless без моста |
| `win-headless-server-*`, `-2` | Windows | Headless как в продакшене |
| `linux-xvfb-*`, `-2` | Docker | Xvfb без моста |
| `linux-xvfb-server-*`, `-2` | Docker | Xvfb как в продакшене |
| `linux-headless-*`, `-2`, `-server`, `-server-2` | Docker | То же в headless |
| `linux-xvfb-linuxpersona-*`, `linux-headless-linuxpersona-*` | Docker | Персона Linux, как в продакшене, с повторами |
| `linux-xvfb-lang-*` | Docker | `LANG=en_US.UTF-8` вместо `C.UTF-8` из образа |
| `win-headless-netlog-*`, `linux-headless-netlog-*` | оба | С NetLog браузера и запросом несуществующего имени: `direct` без моста, `bridged` с ним |

В каждой папке: `result.json`, полный отчёт CreepJS, журнал событий ввода, отчёт rebrowser. Снимки `*.png` в репозиторий не входят: `run.ts` снимает их при новом прогоне. Рядом файлы `compare-A-vs-B.md`.

Что снимается: страница-проба (навигатор, экран, окно, media-запросы, WebGL, WebGPU, canvas, аудио, голоса, устройства, Intl), заголовки запросов в порядке браузера, шрифты по ширине (59 имён Windows, 15 Linux, 10 macOS), `click`, `click_ref`, `type`, `type_ref`, `press_key`, `hover`, `scroll`, `select_option` глазами обработчика страницы, JA4 из сырого ClientHello и HTTP/2 со своим разбором, WebRTC с локальным STUN, CreepJS и rebrowser-bot-detector на своём сервере.

Сторонних запросов нет: у CreepJS STUN заменён на локальный, у rebrowser отключён запрос последней версии Chrome (поэтому `useragent` нейтральный). `storagePartitioning` нейтральный, потому что он только для Chromium 148+. Коммиты и sha256 в `scripts/detection-baseline/assets.lock.json`.

## Как повторить

```bash
corepack yarn install
docker build -f docker/Dockerfile --target baseline -t multizen-baseline:local .

# Всё: 48 прогонов и сравнения, около получаса.
corepack yarn workspace @multizen/detection-baseline matrix \
  --engine-version-dir "%APPDATA%\MultiZen\chromium\cloakbrowser\146.0.7680.177.5" \
  --camoufox-install "<папка установленного Camoufox>"

# Один прогон на Windows.
corepack yarn workspace @multizen/detection-baseline baseline --engine cloakbrowser --mode headless \
  --label my-run --data-dir %TEMP%\mzb --device windows-desktop-nvidia \
  --egress block-private --egress-allow localhost,127.0.0.1

# Один прогон в Docker. Результат попадёт в docs/detection-baselines.
docker compose run --rm baseline --engine cloakbrowser --mode xvfb --label my-run \
  --data-dir /data --cache-dir /data/baseline-assets

# Сравнение. Код выхода 0, с --fail-on-diff 1 при отличиях, 2 при HeadlessChrome, webdriver или pointer: none.
corepack yarn workspace @multizen/detection-baseline compare 2026-10-31-a 2026-10-31-b --repeat 2026-10-31-a-2
```

Без флагов движка он скачается: на Windows заново в каждый прогон матрицы, в Docker один раз в том `multizen-baseline-data`. Десять прогонов матрицы открывают настоящее окно поверх остальных меньше чем на минуту (фокус клавиатуры не забирают), четыре из них ещё на 12 секунд закрывают весь экран чёрным. На это время не трогайте мышь: настоящий курсор над окном попадёт в журнал событий. `docs/` в `.gitignore`, для коммита нужен `git add -f`.

`--repeat` говорит сравнению, что отличается у настройки само по себе, и это в таблицу не идёт. Без него сравнение Camoufox бесполезно: см. ниже.

## Сравнения

### Windows с окном против Windows headless

Файлы: `compare-…-win-headed-desktop-cb-vs-…-win-headless-cb.md`, `…-cf-vs-…-cf.md`.

**CloakBrowser.** Детектор может увидеть три вещи:

- `screen.colorDepth` и `pixelDepth`: 32 с окном, 24 в headless. На этой машине окно отдаёт 32, 24 тоже обычное значение.
- `any-pointer: coarse`: есть с окном, нет в headless. У машины есть сенсорный ввод, а `--blink-settings` в headless оставляет только мышь. При этом `maxTouchPoints` остаётся 10, так что на сенсорной машине эта пара друг другу противоречит. На машине без сенсора противоречия не будет.
- Размеры окна, canvas, WebGL, шрифты, голоса, заголовки, JA4, HTTP/2, события ввода совпадают полностью.

CreepJS и rebrowser дают одно и то же.

**Camoufox.** Без отличий, кроме того что меняется от запуска к запуску и у него самого. CreepJS и rebrowser дают одно и то же.

### Linux Xvfb против Linux headless

Файлы: `compare-…-linux-xvfb-cb-vs-…-linux-headless-cb.md`, `…-cf-vs-…-cf.md`, для Linux-персоны `…-linuxpersona-…`.

**CloakBrowser.** В headless хуже:

- WebGL: 33 расширения вместо 35, другой хеш набора.
- Другие хеши canvas и эмодзи, стабильно от запуска к запуску. Причина не в шуме отпечатка: сид один и тот же.
- CreepJS добавляет в мусор `WebGLRenderingContext.getParameter`: `suspicious gpu` и `suspicious capabilities`.
- Заголовки, JA4, HTTP/2, события ввода, указатель и hover совпадают. Рейтинг «похоже на headless» один и тот же, то есть `--blink-settings` своё дело делает.

**Camoufox.** В headless **WebGL нет вообще**, `getContext('webgl')` даёт `null`. Под Xvfb он есть. Сайт, которому нужен WebGL, сломается, а детектор увидит это одной строкой. На Windows в headless WebGL есть, так что это особенность Linux.

### Windows с окном против Linux Xvfb

Файлы: `compare-…-win-headed-desktop-cb-vs-…-linux-xvfb-cb.md`, `…-cf-vs-…-cf.md`.

**CloakBrowser, Windows-персона.** Совпадает всё сетевое и весь ввод. rebrowser один и тот же, включая проверку цвета `ActiveText` на подмену ОС. Отличается:

- Шрифты, главный провал: см. раздел о шрифтах.
- Эмодзи: другая ширина и другой хеш, 😀 рисует Noto Color Emoji, а не Segoe UI Emoji. CreepJS находит другой набор эмодзи.
- Аудио: `maxChannelCount` 2 вместо 8, `baseLatency` 0.0091875 вместо 0.01.
- Устройства: `audiooutput, audiooutput, audioinput, videoinput` вместо `audioinput, videoinput, audiooutput`.
- `maxTouchPoints` 0 вместо 10, что на обычной машине нормально.
- `innerWidth` равен `outerWidth` (1920 и 1920). На Windows разница 16 пикселей, рамка окна, так что для Windows-персоны равные значения необычны.
- canvas другой: шрифты рисует другой растеризатор.
- `prefers-color-scheme` и `prefers-reduced-motion` берутся у хоста, на эту пару они не влияют.

**CloakBrowser, Linux-персона.** Шрифтовая дыра закрыта, персона согласована с ОС, но CreepJS поднимает «похоже на headless» до 50 %: `noTaskbar`, `hasVvpScreenRes`, `hasKnownBgColor`, `noWebShare`, `prefersLightColor`. Первые два от того, что `availHeight` равен высоте экрана: у окна без панели задач и без оконного менеджера так и есть. Ещё у `linux-laptop-nvidia` WebGL-рендерер записан как `NV178` от Mesa, CreepJS ставит ему confidence low, grade F и `suspicious gpu`. Это данные персоны в `fingerprint.ts`, а не сервер. На Windows-персоне такого нет. С правками от 2026-11-01 `noTaskbar` и `hasVvpScreenRes` ушли (38 %), а `NV178` заменён: см. [об окружении](#окружение-и-персоны-linux-2026-11-01-вечер).

**Camoufox, Windows-персона.** Шрифты в порядке: у него свой набор, 57 из 59 имён Windows и в образе. Зато отличается то, что Firefox берёт у системы:

- 0 голосов вместо 1, 0 устройств вместо 2.
- Аудио 44100 Гц и 0 каналов вместо 48000 и 8. Ноль каналов выхода на настольной машине выглядит странно.
- 959 глобальных имён вместо 1003: нет 41 класса `GPU*` (`navigator.gpu` отсутствует) и `Touch`, `TouchEvent`, `TouchList`. Firefox на Windows их показывает, на Linux нет, и для Windows-персоны это подсказка про настоящую ОС.

Со звуковым сервером в образе (2026-11-01) устройство одно, `audioinput`, а звук 48000 Гц и 2 канала. Голосов по-прежнему 0 (speech-dispatcher не взят, см. ниже), а `GPU*` и `Touch*` нет у самого Firefox на Linux, окружением их не добавить.

На Linux-персоне голосов, устройств и аудио тоже нет, а `availHeight`, видеокарта и остальное случайны, как всегда у него.

## Окружение и персоны Linux (2026-11-01, вечер)

Попытка закрыть разрыв на Linux тем, что есть у настольной Linux и нет у контейнера, без JS и CDP поверх движка. Менялись `docker/Dockerfile`, `docker/session.sh`, `docker/pipewire.conf` и персоны в `fingerprint.ts`, плюс несколько строк в `ChromiumBrowserDriver.ts`, которые передают движку то, что в персоне уже было.

Где мерили: не на машине из шапки, а в облачном Linux-контейнере с Docker, тот же `--target baseline` и тот же `docker run`, что у `matrix.ts`. Сначала проверено, что эта машина даёт то же, что Docker Desktop: образ до изменений против сохранённых прогонов 2026-10-31 даёт 0 отличий у CloakBrowser (`linux-xvfb-server`, `linux-headless-server`, обе Linux-персоны). У Camoufox 0, 1 и 11: число сэмплов аудио, вариант UA с `Ubuntu` и эмодзи, то есть то, что он вытягивает заново при каждом запуске. Прогоны `2026-11-01-v0-*`.

### Звук: PipeWire с немыми динамиком и микрофоном

В образе не было звукового сервера. Без него CloakBrowser пишет в поддельный выход Chromium, а Camoufox устройств не видит вовсе.

| | Без сервера | С PipeWire | Десктоп Windows |
| --- | --- | --- | --- |
| CloakBrowser `baseLatency` | 0.0091875 (441 / 48000, поддельный выход) | 0.010667 (512 / 48000) | 0.01 |
| CloakBrowser устройства | `audiooutput, audiooutput, audioinput, videoinput` | `audioinput, audiooutput` | `audioinput, videoinput, audiooutput` |
| Camoufox частота и каналы | 44100 Гц, 0 | 48000 Гц, 2 | 48000 Гц, 8 |
| Camoufox устройства | нет | `audioinput` | `audioinput, videoinput` |

Двух `audiooutput` без разрешения настоящий Chrome не показывает: он отдаёт по одному устройству каждого вида. Камеры нет, и это остаётся отличием: в контейнер её не дать. Каналов 2, а не 8, как у этой машины: у ноутбука стерео обычное дело. Больше ничего в прогоне не меняется, ни у одного движка, кроме того, что Camoufox и так вытягивает заново.

PulseAudio даёт те же значения (`2026-11-01-v1-*`), но тянет за собой ffmpeg и прибавляет к образу 200 МБ. PipeWire с WirePlumber прибавил 20. WirePlumber без шины D-Bus не связывает потоки с устройством, поэтому у него своя шина в `/tmp`, а не в `XDG_RUNTIME_DIR`: туда браузеры сами смотрят в поисках сессии. Браузеры находят звук через `XDG_RUNTIME_DIR`, его оба драйвера уже передают.

### Голоса: speech-dispatcher не взят

С `speech-dispatcher` и `espeak-ng` Camoufox отдаёт странице 13 362 голоса на 130 языков, все `localService: false`, без голоса по умолчанию (`2026-11-01-v2-linux-xvfb-server-cf`). На десктопе у него один голос Microsoft. Для Windows-персоны это прямое указание на Linux, а на Linux-персоне ноль голосов у Firefox встречается чаще, чем тринадцать тысяч. CloakBrowser на speech-dispatcher не смотрит: у Windows-персоны свои шесть голосов Microsoft и Google, у Linux-персоны три Google, с ним и без него. Так что в образе его нет.

### Шрифты

| | До | После |
| --- | --- | --- |
| CloakBrowser, Linux-персона: Linux-имён из 15 | 8 | **11**: плюс Ubuntu, Cantarell, FreeSans |
| CloakBrowser, Linux-персона: CreepJS `fontFaceLoadFonts` | DejaVu Sans, Liberation Mono, Noto Color Emoji | плюс **Ubuntu**, который CreepJS считает признаком Linux |
| CloakBrowser, Windows-персона: Windows-имён из 59 | 3 | **5**: плюс Calibri и Cambria |
| CloakBrowser, Windows-персона: CreepJS | Noto Color Emoji | то же |
| Camoufox | свои шрифты | без изменений |

Calibri и Cambria здесь это Carlito и Caladea: Chromium принимает их вместо оригиналов по метрикам, как у LibreOffice. Проверку по ширине они закрывают, по картинке нет. Ubuntu, Cantarell и FreeSans CloakBrowser для Windows-персоны прячет, как прятал Liberation и DejaVu. `fonts-ubuntu` лежит в non-free у Debian из-за правил о названии, лицензия Ubuntu Font Licence 1.0 распространять разрешает.

Не взяты, по замеру (`2026-11-01-v3-*`):

- `fonts-noto-core` дал бы Noto Sans и Noto Serif из списка пробы, но вместе с ними Noto Sans Gunjala Gondi, Masaram Gondi, Canadian Aboriginal и Noto Serif Yezidi. CreepJS держит их как признак macOS 12 и 13, и видны они любой персоне.
- `fonts-croscore` даёт Arimo и Cousine, признаки Linux для CreepJS, но CloakBrowser их у Windows-персоны не прячет.
- Roboto и Droid Sans из списка пробы CreepJS считает Android.

### Панель у Linux-персоны

У Windows-персоны CloakBrowser сам рисует панель задач в 48 пикселей (`availHeight` 1032 при 1080), у Linux-персоны никакой: `availHeight` и `outerHeight` равны высоте экрана, и CreepJS ставит `noTaskbar` и `hasVvpScreenRes`. В персоне `availScreen` был всегда (у Linux высота экрана минус 30), но до движка не доходил. Теперь драйвер передаёт его флагом движка `--fingerprint-taskbar-height`, только для Linux-персоны. Итог: `availHeight` и `outerHeight` 1410 при 1440, «похоже на headless» 38 % вместо 50. Оставшиеся шесть признаков (`hasKnownBgColor`, `noWebShare`, `prefersLightColor` и три, которые есть и у десктопа) показывает Chrome на любом Linux: `ActiveText` там красный, Web Share нет. Это касается и уже созданных Linux-профилей: с этой версии их `availHeight` на 30 меньше.

### Видеокарта Linux-персоны

Строки GPU у `linux-*` теперь в том виде, в каком их отдаёт Chrome на Linux: ANGLE поверх OpenGL, вендор `Google Inc. (…)`. Так же их пишет и собственный набор CloakBrowser для Linux, если не передавать ему видеокарту: 61 сид из 61, все NVIDIA, вида `ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77)`. Убраны имена чипов nouveau (`NV178`, `NV137`), `Mesa` как вендор у строк собственного драйвера NVIDIA и виндовые `(0x…)`.

Оценку CreepJS строка теперь получает A везде. Но CloakBrowser подбирает под вендора и сами параметры WebGL, и тут замер разошёлся с проверкой кода CreepJS на сохранённых параметрах:

| Linux-персона, Xvfb | `MAX_TEXTURE_SIZE`, `MAX_SAMPLES` | Оценка | Мусор CreepJS про WebGL |
| --- | --- | --- | --- |
| `NV178`, как было | 16384, 16 | **F** | `suspicious gpu` |
| Intel, новая строка | 16384, 16 | A | нет |
| NVIDIA, новая строка | 32768, 8 | A | `suspicious gpu`, `suspicious capabilities` |
| AMD, новая строка | 32768, 16 | A | `suspicious gpu`, `suspicious capabilities` |
| NVIDIA с OpenGL 4.6, NVIDIA и AMD старыми строками без ANGLE | 32768 | A, у старой NVIDIA C | оба |

Значит, у NVIDIA и AMD на Linux CloakBrowser отдаёт набор параметров, которого CreepJS не знает, какую строку ни дай. Тот же мусор и у строки из его собственного набора (`2026-11-01-x-gpu-cbpool-seed1-cb`, `RTX 3060 … 565.77`). Строкой это не исправить. `NV178` от этого уходил только потому, что движок его не узнавал и брал набор по умолчанию. Последние строки сняты с подменой флагов видеокарты в образе только для замера (`2026-11-01-x-gpu-*`, `run.ts` там читал дополнительные флаги из окружения), в репозиторий этот вариант не входит.

Чистой у CreepJS на Linux остаётся только Intel. Персона по умолчанию на Linux выбирает семейство по сиду, и у четырёх семейств `linux-*` из шести видеокарта NVIDIA или AMD. Сузить выбор по умолчанию до Intel можно, но это вопрос не замера, а того, какое разнообразие нужно, поэтому не сделано.

### Что осталось

- **Windows-персона в Docker**: 52 шрифта Windows из 57, эмодзи Noto вместо Segoe UI. Только Windows-хост или свои шрифты, см. [о шрифтах](#шрифты-на-windows-персоне-в-docker).
- **Камеры нет** ни у одного движка: в контейнер её не дать без устройства на хосте.
- **Каналов 2, а не 8**: у машины-эталона 7.1, у ноутбука обычно стерео. Оставлено стерео.
- **NVIDIA и AMD у CloakBrowser на Linux**: `suspicious gpu` и `suspicious capabilities`, см. выше.
- **Camoufox на Linux**: 0 голосов, нет `GPU*` и `Touch*`, в headless нет WebGL. Глобальных имён 937, как и раньше.
- **Headless у CloakBrowser**: другой canvas и 33 расширения WebGL вместо 35, как и раньше. Разница Xvfb и headless у Linux-персоны упала с 14 до 7 отличий, но не из-за headless: у Xvfb с новой строкой NVIDIA теперь тот же мусор WebGL.
- `connection.rtt` 0 и WebRTC Camoufox на мосту, как и раньше.

Счёт отличий от десктопа почти не изменился (у CloakBrowser на Xvfb 110 и 109, в headless 123 и 122): поле с исправленным, но всё ещё другим значением считается так же, как раньше. Смотреть стоит на сами строки, а не на счёт.

### Прогоны и сравнения

| Прогоны | Образ и дерево |
| --- | --- |
| `2026-11-01-linux-*-session-*`, с `-2` | Итоговые: PipeWire, шрифты, персоны и панель. Четыре настройки Linux (Xvfb и headless, Windows- и Linux-персона) на обоих движках, с повторами, плюс `intelpersona` и `amdpersona` (`--device linux-laptop-intel` и `linux-laptop-amd`) |
| `2026-11-01-v0-*` | Образ до правок, `5f4d19c`. 0 отличий от сохранённых у CloakBrowser, у Camoufox только его собственный разброс |
| `2026-11-01-v1-*` | Плюс PulseAudio. От итоговых отличается только шрифтами |
| `2026-11-01-v2-linux-xvfb-server-cf` | Плюс speech-dispatcher, не взят |
| `2026-11-01-v3-*` | Плюс `fonts-noto-core` и `fonts-croscore`, не взяты |
| `2026-11-01-x-gpu-*` | Подменённые флаги видеокарты, только для замера |

Сравнения: `compare-2026-10-31-linux-*-vs-2026-11-01-linux-*-session-*.md` (что изменилось, с повторами с обеих сторон), `compare-2026-10-31-win-headed-desktop-*-vs-2026-11-01-*-session-*.md` (десктоп против Linux), `compare-*-v0-*.md` (воспроизводимость), `compare-2026-11-01-v1-*.md` (PulseAudio против PipeWire).

Гейт `node apps/server/scripts/acceptance/gate-linux.mjs`: установка 0, typecheck прошёл, из 1188 тестов 1187. Не прошёл `direct: an IPv6 literal goes out unbracketed`: `listen ::1` даёт `EAFNOSUPPORT`, на этой машине нет IPv6 вовсе, и в контейнере, и вне его. К правкам он отношения не имеет. Образ `node:22` для гейта здесь собран с сертификатом прокси песочницы (`--node 22-ccr`), сам скрипт не менялся.

## Открытые вопросы

### Заметно ли страницам отключение отслеживания перекрытия

**Нет, пока окно ничем не закрыто.** CloakBrowser с `CalculateNativeWinOcclusion` и без него: 0 отличий. Camoufox с `widget.windows.window_occlusion_tracking.enabled=false` и без него: только случайные значения, которые у него и так меняются от запуска к запуску.

Разница появляется, когда окно полностью закрыто другим. Это проверено чёрным окном поверх всего экрана:

| Окно закрыто | CloakBrowser без флага | CloakBrowser с флагом | Camoufox без настройки | Camoufox с настройкой |
| --- | --- | --- | --- | --- |
| `visibilityState` | `hidden` | `visible` | `visible` | `visible` |
| Кадры анимации | останавливаются | идут | останавливаются | идут |
| Клик по кнопке | дошёл, но за 5,1 с | дошёл за 0,11 с | **не дошёл за 7 с** | дошёл за 0,1 с |

Так что страница видит не флаг, а окно, которое всё время как будто на переднем плане. Обычная для одного окна картина. Для сервера решение верное: без него страница на закрытом окне просто перестаёт работать. В первой попытке этой матрицы десктопный эталон сам попал в такое: кто-то работал за машиной, окно оказалось закрыто, и `scroll` на CloakBrowser не вернулся за 35 секунд. Поэтому прогоны теперь поднимают окно поверх остальных.

### Прямой профиль через мост против прямого без моста

Файлы: `compare-…-win-headless-cb-vs-…-win-headless-server-cb.md` и такие же для остальных режимов, плюс `…-netlog-direct-…-vs-…-netlog-bridged-…`.

| | Без моста | Через мост | Заметно сайту? |
| --- | --- | --- | --- |
| JA4 CloakBrowser | `t13d1516h2_8daaf6152771_d8a2da3f94cd` | то же | нет |
| JA4 Camoufox | `t13d1617h2_86a278354501_3cbfd9057e0d` | то же | нет |
| HTTP/2 CloakBrowser | `1:65536;2:0;4:6291456;6:262144\|15663105\|0\|m,a,s,p` | то же | нет |
| HTTP/2 Camoufox | `1:65536;2:0;4:131072;5:16384\|12517377\|0\|m,p,a,s` | то же | нет |
| Расширение ECH в ClientHello | есть | есть | нет |
| Кто резолвит имена | браузер, A, AAAA и HTTPS | мост, браузер не резолвит ничего | косвенно |
| DoH | не используется: NetLog показывает `secure_dns_mode` off и на Windows, и в Docker | браузер DNS не делает | нет |
| Настоящий ECH и HTTP/3 | возможны: браузер спрашивает HTTPS-записи, 8 событий задач QUIC | нет: HTTPS-записей нет, 0 событий QUIC | да, для сайта это соединение по HTTP/2 там, где другие Chrome могут идти по HTTP/3. Это вывод, а не замер: QUIC-сервера в замерах нет |
| `connection.rtt` CloakBrowser | 100 или 150 | **0** | **да, это старый признак автоматизации** |
| `connection.downlink` CloakBrowser | около 1,5 | **10** | да |
| WebRTC CloakBrowser | 0 кандидатов | 0 кандидатов | нет разницы |
| WebRTC Camoufox | 4 кандидата, 1 запрос STUN | **`RTCPeerConnection` и `WebTransport` нет совсем** | **да** |
| Настройки Camoufox | по умолчанию | `network.trr.mode=5`, HTTP/3 и WebTransport выкл. | только по последствиям |

Главное:

- **`rtt: 0` и `downlink: 10` даёт один только `--proxy-server`.** На голом бинаре то же даёт и полный набор флагов прокси-профиля десктопа, то есть **каждый прокси-профиль на десктопе уже сегодня такой**, а мост переводит в ту же группу прямые профили. Но все страницы здесь локальные. Изменится ли `rtt` на настоящем сайте через настоящий прокси, отсюда не видно: это проверяется только на внешней странице, а автоматизировать сторонние сайты здесь нельзя. Советую посмотреть один раз вручную, любым прокси-профилем: значение `navigator.connection.rtt` на обычном сайте.
- **Отсутствие `RTCPeerConnection` у Camoufox на мосту заметно одной строкой.** Настоящий Firefox без него почти не бывает. Прокси-профили на десктопе такие же, а на сервере теперь и прямые. Вариант на проверку: `media.peerconnection.ice.proxy_only=true` вместо отключения, API останется, UDP не уйдёт. Не измерялось.

### `LANG=C.UTF-8` в образе

**Подтверждаю: не видно.** CloakBrowser: 0 отличий от `LANG=en_US.UTF-8`. Camoufox: 1, и это набор эмодзи в CreepJS, который у него меняется и сам по себе.

## Режим по умолчанию на Linux

**`auto` остаётся как есть: сначала Xvfb, без него headless.** `displayMode.ts` не менялся, замеры это подтвердили. На обоих движках headless на Linux хуже Xvfb: у CloakBrowser другой WebGL и замечания CreepJS, у Camoufox нет WebGL вообще. Поэтому `--headless` на Linux стоит включать, только если Xvfb поставить нельзя.

## Шрифты на Windows-персоне в Docker

Дыра измерена на CloakBrowser. У Camoufox её нет: он возит шрифты с собой.

| | Десктоп | Linux, Windows-персона |
| --- | --- | --- |
| Шрифтов Windows из 59 по ширине | 57 | **3** (Arial, Courier New, Times New Roman, это подстановки Liberation); с 2026-11-01 **5**, плюс Calibri и Cambria от Carlito и Caladea |
| Нет, по сравнению с десктопом | | **54**: Calibri, Cambria, Consolas, Georgia, Segoe UI, Tahoma, Verdana и остальные |
| Есть то, чего на Windows нет | | Noto Sans CJK SC, Noto Color Emoji |
| CreepJS `fontFaceLoadFonts` | 12 шрифтов | **1**: Noto Color Emoji |
| CreepJS `systemFonts` | `Arial, "Segoe UI"` | `Arial` |
| Системные шрифты `menu`, `status-bar` | `"Segoe UI" 12px` | `Arial 16px` |

При этом CreepJS не пишет это в ложь или рейтинг: `platformEstimate` по-прежнему Windows. Но любой, кто считает шрифты, увидит Windows без её шрифтов, и как раз это детекторы проверяют чаще всего. Варианты:

1. **Linux-персона в Docker** (по умолчанию так и есть, если не указывать `--device`). Лицензии не нужны, противоречий ОС нет. Цена была: CreepJS 50 % и `NV178`. С правками от 2026-11-01: 38 %, строки GPU исправлены, но у NVIDIA и AMD остаются `suspicious gpu` и `suspicious capabilities` от самого движка, см. ниже.
2. **Запускать Windows-персоны на Windows.** Единственный вариант, где замеры показывают полное совпадение со шрифтами.
3. **Том со своими шрифтами**, смонтированный в контейнер, например в `/usr/local/share/fonts/windows`. Шрифты должны быть у вас по лицензии, в образ они не войдут, Microsoft их распространять не разрешает. Не измерялось: Liberation и DejaVu CloakBrowser для Windows-персоны прячет, так что сначала проверьте, покажет ли он добавленные. Признак успеха: `fonts.counts.windows` в прогоне подходит к 57.
4. **Свободные шрифты с теми же метриками** (Carlito вместо Calibri, Caladea вместо Cambria, Selawik вместо Segoe UI). Закроют проверку по ширине, не закроют проверку по картинке. Carlito и Caladea измерены и теперь в образе: Calibri и Cambria по ширине есть, CreepJS в шрифтах ничего нового не видит. Selawik в Debian нет, он не измерялся.
5. **Camoufox вместо CloakBrowser для Windows-персон в Docker.** Шрифты в порядке, но см. выше про голоса, устройства, аудио и WebGPU.

Я бы взял 2 для Windows-персон и 1 для всего остального.

## Что видно во всех режимах, десктоп тоже

Это не про сервер, но детектор видит и это, и раньше этого никто не мерил.

**CloakBrowser**

- **WebRTC: ноль кандидатов и ни одного запроса STUN** во всех 26 прогонах, с мостом и без, на Windows и Linux. Утечки адреса нет, то есть фикс из 0.8.2 на этих двух платформах держится. Но обычный Chrome отдаёт хотя бы mDNS-кандидата, так что пустой результат сам по себе примета. Движок ведёт себя так и без нашего флага политики WebRTC.
- `select_option` даёт непроверенные (`isTrusted: false`) `input` и `change` без единого события мыши или клавиатуры. Так задумано, у списка нет видимого окна.
- `evaluate_js` выполняется в main world: если страница подменила вызываемую функцию, она это увидит (`mainWorldExecution`). `extract` и чтение результата ничего не вызывают.

**Camoufox**

- **Отпечаток меняется при каждом запуске одного и того же профиля.** Мы задаём только ОС, локаль, размер экрана и часовой пояс, остальное он придумывает заново: потоков 2, 8, 12, 16 или 32, видеокарта то Intel, то AMD, то NVIDIA, `availWidth` то 1355, то 5120 при экране 1920. Такой профиль выглядит как новое устройство при каждом входе, а `availWidth` больше ширины экрана сам себе противоречит. Здесь сравнение идёт по `--repeat` именно поэтому: от 49 до 150 отличий между двумя запусками одной настройки. Это, пожалуй, самая серьёзная находка по Camoufox, и правится она в `camoufoxConfigForProfile`.
- **Окно страницы всегда 1280×720.** Это значение по умолчанию у Playwright, мы не передаём `viewport: null`, как делает сам `camoufox-js` в своём запуске. rebrowser показывает жёлтый `viewport`, а `outerWidth` при этом другой.
- Красный `ipcFloodingProtection` и жёлтый `popupBlocking`. Похоже, это настройки Playwright для Firefox, причину я не проверял. rebrowser рассчитан на Chromium, так что к Firefox эти две строки могут подходить не полностью.
- `type` приходит как один `input` без `keydown`, то есть как вставка. `type_ref` даёт клавиши.
- `evaluate_js` работает в изолированном мире и не видит глобальные переменные страницы. Для скрытности это хорошо, но агент должен это знать: `window.что-то` там `undefined`.

## Что не измерено

- **macOS и другие хосты.** Всё только на этой машине и в Docker на ней. В `todo.txt` ещё просили CFT: этого движка в проекте больше нет.
- **Настоящая видеокарта на Linux.** В контейнере её нет, а данные WebGL подменяет движок.
- **Настоящий сайт.** Всё на локальных адресах, поэтому не видно `rtt` на настоящем соединении, ECH с настоящими ключами и HTTP/3. Что мост отнимает QUIC, видно только по счётчику попыток в NetLog.
- **Прокси-профиль с настоящим внешним прокси.** Его набор флагов проверен только на `rtt`, на голом бинаре.
- **Запуск из упакованного десктопа.** Эталон повторяет его команду запуска через тот же драйвер: то же, кроме номера порта, путей и включённого перехвата загрузок.
- **Десктоп на Linux-хосте после правок от 2026-11-01.** Строки GPU и флаг панели доходят и до него, а замерен только Docker. Там у окна есть настоящая панель, и как CloakBrowser сводит её со своей, не проверено.
- **Правки от 2026-11-01 на машине из шапки.** Они сняты в облачном Linux-контейнере с Docker. Что он даёт то же, что Docker Desktop на этой машине, проверено прогонами `v0` (0 отличий), но сами правки там не повторялись.
- **DoH и ECH у Camoufox.** NetLog есть только у Chromium, про Camoufox известно, что в ClientHello есть ECH, и какие настройки выставлены.

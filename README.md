<div align="center">
  <h1>NCreate Server pack</h1>
  <p>Версионируемые файлы и проверяемый manifest официальной сборки NCreate Server.</p>
  <p>
    <a href="https://github.com/Yozekkk/ncreate-pack/actions/workflows/check.yml"><img src="https://github.com/Yozekkk/ncreate-pack/actions/workflows/check.yml/badge.svg" alt="Validate manifests"></a>
    <a href="https://github.com/Yozekkk/ncreate-pack/releases/tag/pack-ncreate-server-stable-v1.0.2"><img src="https://img.shields.io/badge/Stable-1.0.2-2ea44f" alt="Stable 1.0.2"></a>
    <img src="https://img.shields.io/badge/Minecraft-1.21.1-555" alt="Minecraft 1.21.1">
    <img src="https://img.shields.io/badge/NeoForge-21.1.250-e6652a" alt="NeoForge 21.1.250">
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPLv3-555" alt="GPLv3"></a>
  </p>
</div>

Это источник официальной сборки NCreate Server для [NCreate Launcher](https://github.com/Yozekkk/ncreate-launcher). Репозиторий хранит версии конфигураций, NCreate resource pack, метаданные модов и [схему manifest v1](schema/official-edition-v1.schema.json). Launcher получает конфигурации из неизменяемого Git tag, а сторонние моды скачивает из проверенных исходных URL с контролем размера и SHA-256.

Текущая версия Stable — [1.0.2](https://github.com/Yozekkk/ncreate-pack/releases/tag/pack-ncreate-server-stable-v1.0.2). Её источник находится в [`packs/ncreate-server/1.0.2/`](packs/ncreate-server/1.0.2), а опубликованный указатель — в [`channels/stable/ncreate-server.json`](channels/stable/ncreate-server.json). Manifest содержит 718 управляемых файлов, включая 147 модов, и требует Java 21. Версия 1.0.2 уточняет метаданные источников; содержимое игровых файлов совпадает с 1.0.0.

## Что находится в репозитории

```text
packs/ncreate-server/<version>/
  edition.json          Метаданные Minecraft, loader, Java и памяти
  external-sources.json Проверенные источники сторонних модов
  files/                Конфигурации и NCreate resource pack
channels/stable/        Указатель на текущий Stable manifest
schema/                 JSON Schema manifest v1
sources/reviewed.json    Вручную проверенные внешние источники
scripts/                Импорт, сборка, проверки и публикация
docs/SOURCES.md         Правила проверки внешних файлов
```

В Git и GitHub Release **не входят сторонние mod JAR, исходный ZIP игрока, миры, аккаунты, logs, screenshots и caches**. `dist/` содержит временные результаты подготовки релиза и игнорируется Git. За подробностями проверки 147 модов обратитесь к [аудиту источников](docs/SOURCES.md).

## Использование сборки

Установите [NCreate Launcher](https://github.com/Yozekkk/ncreate-launcher/releases) и выберите официальную сборку на главной странице. Launcher читает Stable manifest, скачивает Minecraft и NeoForge, затем устанавливает управляемые файлы. Репозиторий сборки не содержит самостоятельного установщика или готового архива со всеми модами.

Обновление сравнивает manifest с установленными файлами и загружает изменённые managed files. Локальные миры и пользовательские моды сохраняются; конфликт с изменённым управляемым файлом останавливает обновление. Проверки установки и границы подтверждённых сценариев описаны в [документации лаунчера](https://github.com/Yozekkk/ncreate-launcher/blob/main/docs/OFFICIAL-PACK.md).

## Выпуск новой версии

Публикация требует чистого checkout `main`, доступа на запись в GitHub и исходного ZIP из Prism Launcher. Скрипт проверяет, что локальный HEAD совпадает с `origin/main`. Задайте `PACK_VERSION` новым SemVer и запустите:

```bash
./scripts/publish-pack /path/to/new-client.zip "$PACK_VERSION" stable
```

[`scripts/publish-pack`](scripts/publish-pack) анализирует ZIP, исключает пользовательские данные, генерирует manifest и hashes, проверяет источники модов, отправляет исходники в `main` и запускает [workflow публикации](.github/workflows/publish-pack.yml). Workflow создаёт GitHub Release с manifest и `SHA256SUMS.txt`, сверяет загруженные assets и только затем переключает Stable или Beta указатель. Конфигурации читаются по неизменяемому Git tag без сотен отдельных Release assets. Для Beta передайте `beta` третьим аргументом. Повторная публикация той же версии и откат номера версии запрещены.

Новые моды, которые не находятся по точному SHA-512 в официальном Modrinth API, **останавливают публикацию**. Добавляйте их в [`sources/reviewed.json`](sources/reviewed.json) только после проверки официального источника, прав на распространение, URL, SHA-256 и размера. Ни один JAR нельзя заливать в этот репозиторий или Release для обхода такой проверки. Процесс проверки источников описан в [документе](docs/SOURCES.md).

Перед публикацией можно повторить локальные проверки на Node.js 22 и Python 3:

```bash
npm ci --ignore-scripts
npm run check
output="$(mktemp -d)"
node scripts/prepare-release.mjs --edition ncreate-server --channel stable --version "$PACK_VERSION" --output "$output"
node scripts/verify-external-sources.mjs "$output/manifest.json"
```

`npm run check` запускает Node.js и Python-тесты, затем валидирует каналы. `prepare-release.mjs` строит manifest для уже импортированной версии; `verify-external-sources.mjs` повторно скачивает внешние файлы и проверяет размеры и SHA-256. Изменённый код лаунчера публикуется отдельно в [ncreate-launcher](https://github.com/Yozekkk/ncreate-launcher). Репозиторий [ncreate-manifests](https://github.com/Yozekkk/ncreate-manifests) содержит отдельный, пока не подключённый pipeline для Minimal, Standard и Ultra.

## Безопасность обновлений

Файлы manifest ограничены относительными путями, HTTPS источниками, размерами и SHA-256. Launcher скачивает только изменённые managed files, сохраняет миры и пользовательские моды, а при ошибке восстанавливает предыдущее состояние. Конфликт с изменённым managed файлом останавливает обновление. Новые official manifests не задают произвольные команды запуска или executable files.

## Лицензия

Сборка и её конфигурации распространяются по [GPLv3](LICENSE); права на каждый внешний мод принадлежат его автору. Использование публичных Modrinth/CurseForge файлов не делает NCreate Launcher официальным приложением этих сервисов.

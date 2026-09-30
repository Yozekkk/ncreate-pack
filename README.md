# NCreate Server pack

Официальная серверная сборка NCreate для Minecraft 1.21.1 и NeoForge 21.1.250. Репозиторий содержит версионируемый [manifest](schema/official-edition-v1.schema.json), конфигурации и NCreate resource pack. Сторонние mod JAR-файлы здесь не хранятся: launcher скачивает точные версии из исходных Modrinth, FTB Maven или CurseForge CDN URL и проверяет SHA-256 и размер.

Текущий источник — `packs/ncreate-server/1.0.2/`. Адрес сервера, взятый из исходного клиента: `play.ncreate.online:25076`. Публикуемый manifest находится в `channels/stable/ncreate-server.json` после успешного выпуска. Он появляется в канале только после проверки Release assets и всех внешних загрузок. Manifest 1.0.2 содержит адрес сервера, provider и доступные project/version ID каждого мода; игровые файлы не изменились с 1.0.0.

## Следующая версия

Экспортируйте новый клиент из Prism Launcher в ZIP и запустите из чистого checkout:

```bash
./scripts/publish-pack /path/to/new-client.zip 1.1.0 stable
```

Скрипт безопасно анализирует ZIP, исключает миры, screenshots, logs, caches, аккаунты и резервные файлы, генерирует manifest и hashes, проверяет источники модов, отправляет исходники в `main` и запускает GitHub Actions. Workflow создаёт GitHub Release с manifest и SHA256SUMS, затем переключает stable/beta канал. Конфигурации читаются по immutable Git tag с `raw.githubusercontent.com`, без сотен отдельных Release assets. Канал `beta` указывается третьим аргументом. Публикация той же версии повторно или откат номера версии запрещены.

Новые моды, которые не находятся по точному SHA-512 в официальном Modrinth API, **останавливают публикацию**. Добавляйте их в [`sources/reviewed.json`](sources/reviewed.json) только после проверки официального источника, прав на распространение, URL, SHA-256 и размера. Ни один JAR нельзя заливать в этот репозиторий или Release для обхода такой проверки. Процесс проверки источников описан в [документе](docs/SOURCES.md).

Локальные проверки:

```bash
npm ci --ignore-scripts
npm run check
output="$(mktemp -d)"
node scripts/prepare-release.mjs --edition ncreate-server --channel stable --version 1.1.0 --output "$output"
node scripts/verify-external-sources.mjs "$output/manifest.json"
```

`dist/` — временный результат сборки Release. Его не нужно коммитить. Исходный пользовательский ZIP также не входит в Git. Изменённый код лаунчера публикуется отдельно в [Yozekkk/ncreate-launcher](https://github.com/Yozekkk/ncreate-launcher).

## Безопасность обновлений

Файлы manifest ограничены относительными путями, HTTPS источниками, размерами и SHA-256. Launcher скачивает только изменённые managed files, сохраняет миры и пользовательские моды, а при ошибке восстанавливает предыдущее состояние. Конфликт с изменённым managed файлом останавливает обновление. Новые official manifests не задают произвольные команды запуска или executable files.

Сборка и её конфигурации распространяются под GPLv3; права на каждый внешний мод принадлежат его автору. Использование публичных Modrinth/CurseForge файлов не делает NCreate Launcher официальным приложением этих сервисов.

# Проекты DevHub

Проверено 2026-10-03. DevHub обнаруживает 17 основных проектов; linked worktree и старая копия MediaPipes не создают дополнительные карточки.

| Проект | Назначение / dev-сервисы | Dev по умолчанию | Порты |
| --- | --- | --- | --- |
| Алтай | Сайт «Алтай — живая земля» с 3D-долиной; Montage снимает с него превиз (порт 3107) | site | 3107 |
| analytics | server, web | server, web | 3000, 3001 |
| balkhaev | server, web | server, web | 3000, 3001 |
| balkhaev.com | site | site | 4175 |
| brains | server, web | server, web | 3000, 3001 |
| Gameradar | Витрина релизов игр: краулеры Steam, xREL, RuTracker | app | 3000 |
| Luv Club | Платформа AI-компаньонов: API с WebSocket, воркер очередей, сайт и админка | server, worker, web, admin | 3000, 3001, 3002, 3005, 3003 |
| Harness | Среда агента программирования: десктоп и сервер | desktop | 8787 |
| hub | cloak-browser, companion-chat, companion-payments, openmontage, personas, render, server, worker, web | cloak-browser, companion-chat, companion-payments, openmontage, personas, render, server, web | 3007, 3013, 3012, 3002, 3003, 3008, 3000, 3001 |
| Inference | Общая очередь GPU и CPU этой машины (RTX 5080): через неё идёт любая работа видеокарты | queue | 8765, 8194 |
| MediaPipes | H3 и Qwen: генерация изображений и видео; API провайдеров и outbound worker | api, generation, zemstroy-worker | 8089, 8088 |
| Modeler | Фабрика Blender: персонажи, кадры, превиз; API заказов /v1, которым пользуется Montage | server, web | 3000, 3001 |
| Montage | Фильмы как данные, сцены в 3D и сервис кадров для других проектов | remix, server, videoparse, web | 4747, 3000, 8020, 8010, 3001 |
| persons | server, web | server, web | 3210, 3211 |
| Predict | Локальный runtime прогнозов и paper-стратегий; альтернативный новостной стол Laya | runtime | 8080 |
| Soclogin | Вход и публикации с собственных аккаунтов Instagram, X и Avito | api | 3018 |
| Земстрой CRM | CRM продаж земельных участков: amoCRM, Avito, Telegram | server, web | 3000, 3001 |

Основная папка каждого проекта находится на локальной ветке `stage`. Задачи создаются в `codex/*` worktree, затем интегрируются и проверяются в основной папке. Dev-серверы исполняются только из неё; команды production остаются самостоятельными.

Сервисы с общим портом являются альтернативами: например, Predict runtime/Laya и Montage Studio variants. DevHub запускает группу `launch.dev`, резервирует порты и отказывает при чужом владельце.

В MediaPipes оставлена студия H3/Qwen на 8089, API на 8088 и Zemstroy worker. Старый Gamza/3D/cloud frontend и Next/Expo/Hono templates удалены.

Связи с данными проверяются отдельно от расположения исходников. Inference использует H3/Qwen runtime в Documents-копии MediaPipes; Predict использует состояние `predict-paper/artifacts`. Удаление этих путей требует сначала перенести данные и обновить конфигурацию потребителей. Docker volumes и внешние junction targets не удаляются.

Кнопка удаления показывает основную папку, связанные копии и существующие Git worktree. Конфигурации, ссылки и зависимости проверяются перед подтверждением и перед удалением. Проверенные ссылки на frontend добавляются повторяемой командой `bun run project:interfaces --write`; без `--write` она показывает план.

Legacy-копии `gameradar-postgres-only-20260908` и `vibecoder` удалены с диска и исключены из каталога. Основной Gameradar сохранён.

Звёздочка добавляет проект в избранное: такие проекты всегда идут первыми в обзоре и боковом списке. Карточки и боковые группы можно сворачивать независимо; избранное и сворачивание сохраняются в браузере между открытиями пульта.

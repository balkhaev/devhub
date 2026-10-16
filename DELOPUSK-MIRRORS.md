# Зеркала сервисов delopusk.ru

Все публичные веб-сервисы сервера `delopusk.ru · 81.90.31.214` доступны через
HTTPS-прокси на управляющем сервере `deploy.balkhaev.com · 49.13.216.63`.
Это те же приложения, пользователи, файлы и базы: запрос каждый раз идёт к
существующему production. Отдельных копий приложений и данных нет.

| Сервис | Зеркало | Production, к которому обращается прокси |
| --- | --- | --- |
| CRM Земстрой | https://crm.balkhaev.com | https://crm.delopusk.ru |
| API для работы CRM | https://api.crm.balkhaev.com | https://api.crm.delopusk.ru |
| Кабинет агентов Земстрой | https://app.balkhaev.com | https://agent.xn--80aaphjkeh3cyi.xn--p1ai |
| Алтай | https://altay-mirror.balkhaev.com | https://altay.delopusk.ru |
| GameRadar | https://ggpick.balkhaev.com | https://ggpick.club — приложение на том же сервере, также обслуживает `ggpick.delopusk.ru` |
| Общая Grafana | https://grafana.balkhaev.com | Уже существующий прокси к `81.90.31.214`, Host `grafana.balkhaev.com`, TLS SNI `crm.delopusk.ru` |

Инвентарь проверяется через Coolify API: на сервере находятся `altay`, `ggpick`,
`zemcrm-web`, `zemcrm-server` и Grafana стека `zemcrm-observability`. Внутренние
Postgres, Redis, collectors, embeddings, браузер и Telegram egress публичных
веб-адресов не имеют и через это зеркало не публикуются. Сервисы другого
сервера — Modeler, Montage/Film, Persons, OpenPanel и остальные — уже открываются
по своим адресам и в маршруты зеркала не входят.

## Почему нужен прокси

Прямой SSH-доступ с этой машины к production `81.90.31.214` отсутствует.
С управляющего сервера HTTPS к production работает, а SSH
`root@deploy.balkhaev.com` доступен с локальным ключом. Поэтому прокси установлен
там, без изменения приложений и баз на delopusk.ru.

Старые `zem.balkhaev.com`, `api.zem.balkhaev.com`, `altay.balkhaev.com` указывают
на `81.90.31.214` и перенаправляют на канонические домены. Они не являются
зеркалами. Новые имена в таблице уже разрешаются в `49.13.216.63`; для них
не пришлось менять DNS. `altay-mirror` выбран именно по этой причине.
Если позже использовать старые имена для зеркала, сначала нужны изменения
DNS A/AAAA и явное добавление этих имён в конфигурацию прокси. Одной установки
маршрута на управляющем сервере недостаточно.

## Как устроено

Traefik Coolify завершает публичный TLS и отправляет запрос в контейнер
`delopusk-resource-mirrors`, Nginx на порту 8080 в приватной Docker-сети `coolify`.
Порт контейнера на хосте не публикуется. Только пять явно перечисленных имён
маршрутизируются сюда; неизвестный Host получает 421.

Nginx подключается к фиксированному `https://81.90.31.214`, передавая нужные
канонические Host и TLS SNI. Сертификат проверяется по системным CA;
`insecureSkipVerify` и HTTP до production не используются. Grafana продолжает
использовать существующий `shared-grafana-edge.yaml` и не меняется этой выкладкой.

В CRM абсолютный адрес API в HTML, JS и RSC заменяется на `api.crm.balkhaev.com`.
Известные Origin/Referer зеркала переводятся в соответствующие исходные адреса,
ответ CORS — обратно. Посторонние Origin сохраняются и проверяются самим
приложением. Cookie `.delopusk.ru` получает ограниченный домен
`.crm.balkhaev.com`, общий только для веба и его API; существующие Secure,
HttpOnly и SameSite сохраняются. Вход на зеркале создаёт собственную браузерную
сессию тех же пользователей; cookie исходного домена автоматически не переносится.

Кабинет агентов использует свой same-origin API-посредник. Его hostname в JS
переводится в `app.balkhaev.com`, а Origin/Referer — только для этого точного
зеркала. Сессионные cookie остаются host-only, общий домен `.balkhaev.com` не
выдаётся. Переходы администратора в CRM ведут на `crm.balkhaev.com`.
Клиентские `/agents/book/…` до подписания и оплаты перенаправляются на основной
домен с `Referrer-Policy: no-referrer` и без кеширования: банк возвращает туда же,
где хранится cookie бронирования. Прямой `/api/agent-booking` на зеркале закрыт
с кодом 409; выдаваемые агентом ссылки внутри JSON остаются каноническими.
Занятый другим сервисом `agent.balkhaev.com` в маршруты не входит.

Location и ссылки в HTML/JS/CSS переводятся на адрес зеркала. JSON API,
бинарные файлы и тела входящих запросов не переписываются. WebSocket и потоки
ответов проходят без буферизации. Прокси не кеширует ответы, не повторяет
запросы при ошибке и не скрывает отказ исходного приложения. Ограничения
upstream, в том числе 429, остаются действующими. OAuth callback и абсолютные
URL внутри JSON могут требовать отдельной настройки провайдера/приложения;
их универсальная совместимость без изменения upstream не предполагается.

Upstream получает `Accept-Encoding: ''`, чтобы подстановка адресов выполнялась
над несжатым ответом. После подстановки Nginx сжимает ответы для браузера gzip
(уровень 5, минимум 1024 байта): HTML, JavaScript, CSS, RSC и JSON. Заголовок
`Vary: Accept-Encoding` сохраняет корректный выбор представления. JSON только
сжимается, его ссылки и данные не меняются. `text/event-stream` не входит в
типы gzip; SSE продолжает передаваться без сжатия и буферизации.

При проверке скорости сравнивать `Content-Encoding` и число переданных байтов
с `Accept-Encoding: identity` и `gzip`, а не только код 200. До включения gzip
страница входа агента загружала 16 JS-файлов общим объёмом 1 168 600 байт без
сжатия; один из файлов занимал 283 476 байт против 64 648 байт gzip на основном
домене. Это замер без входа, он не подтверждает защищённые рабочие сценарии.

В access log не записываются URL, параметры, cookie или данные авторизации.
Реальный IP берётся только от текущего адреса Traefik `10.0.1.7`; скрипт
перед выкладкой проверяет этот адрес. Если Coolify пересоздал proxy с другим IP,
нужно обновить `set_real_ip_from`, сверившись с сетью `coolify`.

## Конфигурация и выкладка

Исходники: [infra/delopusk-mirrors](infra/delopusk-mirrors/).
На управляющем сервере Compose и Nginx находятся в
`/data/devhub/delopusk-mirrors/`, маршрут Traefik —
`/data/coolify/proxy/dynamic/delopusk-mirrors.yaml`.

Из канонического `F:/code/devhub`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File infra/delopusk-mirrors/deploy.ps1
```

Скрипт проверяет SSH host key, адрес Traefik и DNS всех пяти имён,
загружает только свои конфиги, валидирует Nginx и Compose, запускает только
контейнер зеркала и атомарно устанавливает свой маршрут Traefik. Traefik
подхватывает файл автоматически; перезапуск Coolify, его proxy или production
не нужен. Обновление контейнера зеркала кратко прерывает его активные потоки.
Образ — официальная стабильная ветка `nginx:1.28-alpine`, закреплённая по digest
`sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236`.

Для диагностики:

```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@deploy.balkhaev.com \
  'docker inspect delopusk-resource-mirrors --format "{{.State.Health.Status}}"; docker logs --tail 30 delopusk-resource-mirrors'
```

Проверять доступность HTTPS и сертификаты, CRM `/login` и её JS с новым адресом
API, API `/api/auth/get-session`, CORS preflight с Origin зеркала и чужим Origin,
Алтай вместе с ассетами, GameRadar и `/login` Grafana. Для полного подтверждения
входа нужен вход владельца на CRM-зеркале; проверки без сессии не доказывают
работоспособность всех защищённых действий.

Удаление только этого прокси: убрать
`/data/coolify/proxy/dynamic/delopusk-mirrors.yaml`, затем выполнить
`docker compose -f /data/devhub/delopusk-mirrors/compose.yaml down`.
Оригинальные приложения, их volumes и существующие маршруты не затрагиваются.

## Проверено 12 октября 2026

- Контейнер `healthy`; Nginx и Compose прошли проверку конфигурации.
- CRM `/login`, API `/api/auth/get-session`, Алтай, GameRadar и Grafana `/login`
  отвечают 200. Сертификаты проверены без исключений, `ssl_verify_result=0`.
- Страница входа CRM, главная Алтая и витрина GameRadar открыты в браузере
  на доменах зеркала. Внутренние ссылки сохраняют адрес зеркала.
- Все JS страницы входа CRM загрузились; chunk `1mgvc4b7r66kx.js` содержит
  `api.crm.balkhaev.com` и больше не содержит `api.crm.delopusk.ru`.
  JS Алтая и GameRadar также отвечает 200.
- CRM CORS preflight возвращает 204 с разрешением именно
  `https://crm.balkhaev.com`; для `https://example.invalid` разрешения нет.
- Неизвестный Host получает 421. Ошибок Nginx и Traefik после установки нет.
- Вход с реальной учётной записью, защищённые операции и OAuth-провайдеры
  не проверялись; они требуют отдельной проверки с сессией владельца.

Директивы прокси и подстановки описаны в документации
[Nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) и
[sub module](https://nginx.org/en/docs/http/ngx_http_sub_module.html), сжатие — в
[gzip module](https://nginx.org/en/docs/http/ngx_http_gzip_module.html).

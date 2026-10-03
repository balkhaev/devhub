# Claude и Codex в DevHub

Раздел **Claude и Codex** находится по адресу `http://127.0.0.1:4700/#/ai`.
Он подключает аккаунты, показывает каталог моделей и выполняет потоковые запросы.
Проекты могут обращаться к тому же локальному API.

## Подключения

- **Continue with ChatGPT**: новый официальный Sign in with ChatGPT для open-source клиентов. DevHub регистрируется под собственным именем; требуется разрешение на ChatGPT plan usage. Список моделей и запросы используют `https://api.openai.com/v1`, а не legacy transport.
- **Claude**: OAuth/PKCE с ручным вводом кода, как в OmniRoute. Доступ стороннего приложения и источник списания определяет Anthropic: авторизация сама по себе не гарантирует использование квоты подписки. При запрете DevHub показывает отказ провайдера.
- **Импорт CLI**: читает только `~/.codex/auth.json` или `~/.claude/.credentials.json` по нажатию кнопки. Импортируются снимки access token. Refresh token CLI не копируется и его файлы не изменяются: после истечения входа повторите импорт из авторизованного CLI. Codex CLI использует отдельный legacy Responses transport.
- Можно подключить несколько аккаунтов. Внутренний идентификатор и выбранная модель видны в панели чата. Повторный вход для подключения ChatGPT сохраняет его регистрацию.
- Отключение в DevHub удаляет локальные токены. Для отзыва разрешения на стороне провайдера отключите DevHub в настройках ChatGPT/Claude.

Токены хранятся на сервере в AES-256-GCM хранилище `.state/ai/accounts.enc`; локальный ключ находится рядом в `vault.key`. Файлы исключены из Git. Защита файловой системы и резервной копии этой папки остаётся важной: копия ключа вместе с vault позволяет расшифровать токены. Unix-права — 0700/0600; в Windows папка AI и ключ локального клиента получают ACL для текущего пользователя, SYSTEM и Administrators. Дополнительные разрешения другим пользователям блокируют чтение и запись секретов; исправьте права и перезапустите DevHub. Пароли, коды и переписка не сохраняются в browser storage, журнал действий или Git.

OAuth использует одноразовый state, PKCE и срок 10 минут. OpenAI ID token проверяется по подписи JWKS, issuer, audience, сроку и nonce; разрешение на inference проверяется отдельно. Обновления собственных OAuth-токенов сериализуются и сохраняются атомарно.

## Локальный API

API слушает только loopback. Браузер обращается с собственной страницы DevHub и `x-devhub: 1`; локальная программа отправляет `x-devhub-client` из файла `.state/client-token`. Значение ключа не возвращается в UI. Это существующий ключ локального DevHub, который также разрешает действия с сервисами; не публикуйте его.

| Endpoint | Назначение |
| --- | --- |
| `GET /api/ai/state` | Подключения без токенов и начальный каталог |
| `GET /api/ai/accounts/:id/models` | Каталог конкретного аккаунта; fallback явно помечен `source: catalog` |
| `POST /api/ai/chat` | Текстовый чат, NDJSON `text` / `done` / `error` |
| `GET /v1/models` | Начальный каталог подключений, ID `accountId/model`; без сетевых запросов провайдеру |
| `POST /v1/chat/completions` | Совместимый текстовый чат, JSON или SSE |
| `POST /v1/responses` | Native OpenAI input, tools и reasoning |
| `POST /v1/messages` | Native Anthropic content blocks, tools и thinking |

Выберите аккаунт в `model: "accountId/model"` либо передайте `x-devhub-account: accountId` с обычным ID модели. Если подключён только один подходящий аккаунт, он выбирается автоматически. Операционные OAuth endpoints перечислены в `src/ai/api.ts`.

Пример запроса из локального Bun/Node проекта:

```ts
import { readFile } from "node:fs/promises";

const client = (await readFile("D:/code/devhub/.state/client-token", "utf8")).trim();
const response = await fetch("http://127.0.0.1:4700/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-devhub-client": client },
  body: JSON.stringify({
    model: "<accountId>/<modelId>",
    messages: [{ role: "user", content: "Объясни этот алгоритм." }],
    stream: false,
  }),
});
if (!response.ok) throw new Error(`DevHub HTTP ${response.status}`);
console.log(await response.json());
```

`/v1/chat/completions` поддерживает текстовые messages и явно перечисленные параметры. Для function calling, изображений и structured content используйте native endpoint соответствующего провайдера. Неизвестные/неподдерживаемые native параметры возвращают 400. Legacy Codex не поддерживает явные output cap, temperature, top_p, truncation и background. В интерфейсе лимит длины для такого аккаунта отключён. Native storage всегда `store: false`; upstream OpenAI subscription запрос всегда потоковый, а `stream: false` клиента агрегируется только после полного завершения.

Лимит HTTP-тела — 1 МБ, текстового/native payload — 256 КБ, ожидание inference — 3 минуты. Прерванный запрос отменяет upstream. Частичный ответ сохраняется в интерфейсе, но ошибка/обрыв до `response.completed` или `message_stop` не считается успехом. 401 требует повторного входа, 403 означает отказ доступа, 429 — лимит провайдера. Автоматического переключения аккаунтов и повторов платных запросов при лимите нет.

## Источники

Реализация протоколов изучена в [OmniRoute](https://github.com/diegosouzapw/OmniRoute/tree/23a11484862b3bb589a55e85b00e4ac53ffeb234); лицензия и атрибуция сохранены в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Новый OpenAI OAuth следует [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) и [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
Особенности доступа Claude описаны в [официальной справке](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account).


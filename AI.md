# Подписки и AI-прокси DevHub

Раздел **Claude и Codex** находится по адресу `http://127.0.0.1:4700/#/ai`.
DevHub подключает несколько подписок, распределяет запросы между аккаунтами и предоставляет локальный API для приложений. Сейчас адаптеры поддерживают **OpenAI Codex / Sign in with ChatGPT и Claude**. Это ядро прокси, а не полная копия всех провайдеров и расширений OmniRoute.

## Подключение подписок

- **Continue with ChatGPT**: официальный Sign in with ChatGPT для open-source клиентов. DevHub регистрируется под собственным именем; требуется разрешение на ChatGPT plan usage. Каталог и inference используют `https://api.openai.com/v1`.
- **Claude**: OAuth/PKCE с ручным вводом кода, как в OmniRoute. Доступ стороннего приложения и источник списания определяет Anthropic. Успешная авторизация не гарантирует доступ к квоте подписки: сторонний инструмент может расходовать разрешённые провайдером usage credits. Отказ доступа возвращается клиенту.
- **Импорт CLI**: по нажатию кнопки читаются только `~/.codex/auth.json` или `~/.claude/.credentials.json`. DevHub сохраняет снимок access token, не копирует refresh token и не изменяет файлы CLI. После истечения снимка повторите импорт из авторизованного CLI. Codex CLI использует отдельный legacy Responses transport. У opaque Claude token нет подтверждённого account ID: повторный импорт того же token обновляет снимок, а после его ротации создаётся отдельный снимок. Отключайте старые подключения вручную; локальный `.claude.json` может содержать устаревшую identity и не используется для слияния аккаунтов.
- OAuth-подключения обновляют собственные токены. Повторный вход в существующее подключение ChatGPT сохраняет его настройки и регистрацию DevHub. Подключайте разные аккаунты отдельными входами и назначайте им понятные названия.
- Отключение удаляет локальные токены. Для отзыва разрешения у провайдера отключите DevHub в настройках ChatGPT/Claude.

Токены, настройки маршрутизации и хеши ключей прокси хранятся в AES-256-GCM vault `.state/ai/accounts.enc`; локальный ключ находится рядом в `vault.key`. Оба файла исключены из Git. Копия vault вместе с ключом позволяет расшифровать токены. Unix-права — 0700/0600; в Windows приватные файлы получают ACL для текущего пользователя, SYSTEM и Administrators. Дополнительные разрешения другим пользователям блокируют операции с секретами. Пароли, коды и переписка не сохраняются в browser storage, журнал действий или Git.

OAuth использует одноразовый state, PKCE и срок 10 минут. OpenAI ID token проверяется по JWKS-подписи, issuer, audience, сроку и nonce; inference scope проверяется отдельно. Refresh собственных OAuth-токенов сериализуется и сохраняется атомарно.

## Пулы и маршруты

Модель `codex/<modelId>` или `claude/<modelId>` выбирает подходящий аккаунт из пула провайдера. `accountId/<modelId>` либо `x-devhub-account: accountId` закрепляет конкретное подключение; при его недоступности другой аккаунт не подставляется. Для удобных названий задайте alias, например `coding` → `codex/<modelId>`. Alias также может быть закреплён за конкретным аккаунтом.

У подключения есть `enabled`, название, `priority`, `weight` и `maxConcurrency`. Более высокий priority обслуживается первым; нижний используется, когда верхний недоступен. Отключённые, истёкшие, занятые и временно ограниченные аккаунты исключаются из выбора. По умолчанию разрешены два одновременных запроса на аккаунт; настройка принимает значения 1–32. Общий предел процесса — 64.

| Стратегия | Выбор среди доступных аккаунтов одного приоритета |
| --- | --- |
| `round-robin` | Чередование с учётом веса |
| `fill-first` | Первый подходящий аккаунт до его ограничения |
| `least-busy` | Наименьшая занятость с учётом concurrency и веса |

Заголовок `x-devhub-session` сохраняет предпочтение аккаунта на 30 минут после использования. Привязка изолирована по ключу приложения, провайдеру и модели. При недоступности аккаунта пул может выбрать другой. Для истории с opaque reasoning или состоянием инструментов используйте явное закрепление `accountId/model`: мягкая привязка сессии не гарантирует перенос такого состояния между аккаунтами. OpenAI native storage всегда `store: false`; официальный SIWC HTTP transport не поддерживает `previous_response_id`, поэтому передавайте историю input явно.

Слоты concurrency освобождаются после завершения, ошибки или отмены потока. Если все подходящие подключения недоступны, DevHub возвращает 429 и время ожидания. Очереди с неограниченным ожиданием нет.

## Ключи приложений

Создайте отдельный ключ во вкладке прокси и передайте его приложению через переменную окружения `DEVHUB_AI_KEY`. Секрет показывается один раз; сервер сохраняет только SHA-256 хеш и публичный префикс. Ключ можно ограничить сроком, провайдерами, аккаунтами, моделями и числом запросов в минуту, затем отозвать. Списки ограничений — точные значения, без wildcard. `allowedModels` принимает запрашиваемое имя/alias либо canonical `provider/model`; ограничения аккаунтов задаются отдельно через `allowedAccounts`. Отсутствующее ограничение разрешает все значения соответствующей категории.

Ключ приложения принимает `Authorization: Bearer <key>` либо `x-api-key: <key>` и разрешает только AI endpoints `/v1`. Он не разрешает подключение аккаунтов, управление ключами или запуск сервисов DevHub. Управление остаётся доступно с собственной страницы DevHub (`x-devhub: 1`) либо с административным `x-devhub-client` из `.state/client-token`. Последний даёт доступ и к сервисам; приложениям для inference выдавайте отдельные ключи прокси.

Сервер слушает loopback. Проверки Host и Origin действуют и для ключей прокси. Ключи сохраняются между перезапусками; счётчики RPM, статистика, cooldown и привязки сессий относятся к текущему процессу и сбрасываются при перезапуске.

## API и SDK

| Endpoint | Назначение |
| --- | --- |
| `GET /v1/models` | Модели пулов и aliases, разрешённые ключом; каталог без inference |
| `POST /v1/chat/completions` | Единый Chat Completions формат для обоих провайдеров; JSON или SSE |
| `POST /v1/responses` | Native OpenAI input, tools и reasoning; пул Codex |
| `POST /v1/messages` | Native Anthropic content blocks, tools и thinking; пул Claude |
| `GET /api/ai/state` | Подключения, настройки прокси, публичные ключи и статистика |
| `GET /api/ai/accounts/:id/models` | Каталог аккаунта; fallback помечен `source: catalog` |
| `POST /api/ai/chat` | UI-чат; NDJSON `route` / `text` / `done` / `error` |
| `POST /api/ai/accounts/:id/config` | enabled, название, priority, weight, maxConcurrency |
| `POST /api/ai/proxy/config` | Стратегия и массив aliases |
| `POST /api/ai/proxy/keys` | Создание ключа; ответ `{ key, record }` |
| `POST /api/ai/proxy/keys/:id/revoke` | Отзыв ключа |

Management endpoints требуют административной авторизации. OAuth endpoints перечислены в `src/ai/api.ts`. Статический каталог не подтверждает entitlement конкретной подписки; доступность проверяет провайдер при запросе.

Пример OpenAI SDK из Bun/Node проекта; выберите modelId из каталога DevHub:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.DEVHUB_AI_KEY,
  baseURL: "http://127.0.0.1:4700/v1",
  maxRetries: 0,
});

const stream = await client.chat.completions.create({
  model: "codex/<modelId>", // либо claude/<modelId> или ваш alias
  messages: [{ role: "user", content: "Объясни этот алгоритм." }],
  stream: true,
}, { headers: { "x-devhub-session": "my-project-conversation-1" } });

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? "");
}
```

Для native Claude у Anthropic SDK baseURL задаётся **без `/v1`**:

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.DEVHUB_AI_KEY,
  baseURL: "http://127.0.0.1:4700",
  maxRetries: 0,
});

const message = await client.messages.create({
  model: "claude/<modelId>",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Объясни этот алгоритм." }],
});
console.log(message.content);
```

`maxRetries: 0` важен: SDK имеет собственные автоматические повторы и может повторить запрос после сетевого обрыва независимо от политики DevHub. Отмена запроса отменяет upstream.

Chat Completions поддерживает system/developer/user/assistant/tool, function tools и tool results, `tool_choice` и `parallel_tool_calls`, текст и `image_url` (HTTPS либо inline PNG/JPEG/GIF/WebP), inline `file_data` с filename. Для Claude файл должен быть PDF data URL, а `image_url.detail` — отсутствовать либо иметь значение `auto`. Tool results должны непосредственно следовать за соответствующим assistant tool call. Для OpenAI поддерживаются `reasoning_effort` и `response_format` text/json_object/json_schema; thinking и provider-specific blocks используйте через native endpoint. DevHub не создаёт подписи thinking и не меняет имена инструментов.

Неизвестные и неподдерживаемые параметры возвращают 400. SIWC и legacy Codex не поддерживают явные output cap, temperature и top_p; лимит длины в UI отключён для всех подключений OpenAI. SIWC также отклоняет metadata, previous_response_id, background и другие параметры, отсутствующие в официальном preview transport. OpenAI subscription transport потоковый; `stream: false` клиента агрегируется после полного завершения. Лимит HTTP-тела и сериализованного payload — 1 МБ; суммарный текст UI-чата — 256 КБ. Ожидание inference — 3 минуты. Инструменты и изображения должны поддерживаться выбранной моделью и её транспортом.

## Ошибки и учёт

Переключение пула допустимо при отказе до принятия inference, например при явном ответе 429. Запрос с закреплённым аккаунтом остаётся на нём. Обрыв после HTTP 200, неоднозначная сетевая ошибка и частичный поток не запускают повторный платный запрос: отсутствие текста не доказывает отсутствие списания. После начала ответа ошибка передаётся в потоке; success требует корректного терминального события провайдера, а не только закрытия соединения.

401 блокирует подключение до восстановления авторизации; 403 означает отказ доступа, 429 — ограничение. Cooldown использует проверенные сведения об ожидании провайдера и ограниченный запасной интервал. Метрики показывают запросы, завершения, ошибки, активные слоты и reported input/output tokens. Они не сохраняют prompts, ответы или raw provider errors и не являются сведениями о стоимости подписки или остатке квоты.

## Что изучено в OmniRoute

Аудит выполнен по [OmniRoute 3.8.52, commit 23a11484862b3bb589a55e85b00e4ac53ffeb234](https://github.com/diegosouzapw/OmniRoute/tree/23a11484862b3bb589a55e85b00e4ac53ffeb234). Изучались исходники, а не только README. Число в маркетинговом каталоге не равно числу адаптеров DevHub: upstream содержит aliases, разные способы авторизации и отдельные медиа-провайдеры.

| Область upstream | Конкретные исходники | Адаптация в DevHub |
| --- | --- | --- |
| OAuth, импорт, refresh | `src/lib/oauth/providers`, `src/lib/oauth/utils`, `open-sse/services/tokenRefresh` | Два провайдера, официальный SIWC, CLI snapshots, проверка identity и атомарный refresh |
| Пулы и admission | `src/sse/services/auth.ts`, `open-sse/services/accountSemaphore.ts`, `open-sse/services/admission` | Три стратегии, приоритеты, веса и concurrency; слоты держатся до конца ответа |
| Sticky и leases | `src/sse/services/sessionAffinityPin.ts`, `src/lib/db/sessionAccountAffinity.ts`, `open-sse/services/combo/nativeCodexTurnPin.ts` | Мягкая привязка сессии и явный account pin; durable exclusive leases не перенесены |
| Failover и circuit breakers | `open-sse/services/accountFallback`, `src/sse/services/sameAccountTransportRetry.ts`, `src/shared/utils/circuitBreaker.ts` | Ограниченный failover до принятия inference; без hedging и replay частичного ответа |
| Форматы и SSE | `open-sse/translator`, `open-sse/utils/stream.ts`, `open-sse/utils/sseOutputSignal.ts` | Chat Completions плюс native Responses/Messages; tools/usage/terminal events отдельно от текста |
| Модели, combos, auto-routing | `open-sse/services/model.ts`, `open-sse/services/combo`, `open-sse/services/autoCombo` | Provider/account prefixes и простые aliases; nested combos, fusion/pipeline и scoring не перенесены |
| Ключи и ограничения | `src/lib/db/apiKeys.ts`, `src/lib/usage/apiKeyUsageLimits.ts`, `src/lib/apiKeyExposure.ts` | Hashed-only ключи, provider/account/model scopes, expiry/revoke/RPM; без USD budgets/IP schedules |
| Квоты и аналитика | `src/domain/quotaCache.ts`, `open-sse/services/usage`, `src/lib/db/usageAnalytics.ts` | Metadata-only метрики и реактивный cooldown; без остатка квоты и расчёта billing |
| Провайдеры и плагины | `src/shared/constants/providers`, `open-sse/config/providers`, `open-sse/config/providerPluginManifest.ts`, `src/lib/plugins` | Граница адаптеров; многочисленные сторонние providers и исполняемые plugins не подключены |
| Расширения | `open-sse/mcp-server`, `src/lib/a2a`, `src/lib/memory`, `src/app/api/skills` | MCP/A2A, memory, skills, semantic cache, compression и media APIs пока вне интеграции |

Каталог upstream охватывает API-key сервисы (frontier labs, inference hosts, gateways, enterprise clouds, regional и media), OAuth сервисы, web-cookie адаптеры, локальные Ollama/LM Studio/vLLM/llama.cpp/ComfyUI, upstream proxies CLIProxyAPI/9router и cloud agents. Gemini, Copilot, Cursor, Kiro, Antigravity, Kimi, Grok, Azure/Bedrock и OpenRouter относятся к **исследованному upstream**, а не к подключаемым провайдерам текущего DevHub.

Следующие расширения требуют самостоятельной реализации: provider/model quota telemetry с честным `unknown`, circuit breakers и bounded admission queue, capability-aware fallback между моделями, durable leases для агентских сессий, каталоги новых адаптеров и идемпотентность concurrent requests. Fanout/fusion/shadow dispatch может создавать несколько оплачиваемых запросов; его нельзя включать как скрытый fallback. Provider telemetry нужно отделять от локальных метрик, а внутренние бюджеты — от реального billing провайдера.

## Источники и лицензия

Атрибуция и полный MIT notice сохранены в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). OpenAI OAuth следует [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) и [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference). Доступ Claude описан в [официальной справке](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account). SDK-конфигурация опирается на [OpenAI Node SDK](https://github.com/openai/openai-node) и [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript). DevHub представляется своим именем и не переносит Claude Code impersonation, device cloaking и обфускацию клиентского fingerprint из OmniRoute.

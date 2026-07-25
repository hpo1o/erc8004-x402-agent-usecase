# Setup Guide — ERC-8004 + x402 Reference Implementation

Пошаговая инструкция для запуска демо:
**ERC-8004 Discovery → GPT Image 2 → x402 оплата → grayscale → output.jpg**

Agent 2 (Colorizer Service) работает публично на Railway:
**https://erc8004-agent-demo-production.up.railway.app**

Image Generator находит его автоматически через блокчейн — никаких localhost не нужно.

---

## Что нужно

| Что | Зачем |
|---|---|
| OpenAI API key | Agent 1 генерирует изображение через GPT Image 2 |
| MetaMask кошелёк (два адреса) | Плательщик (Agent 1) и владелец агента (Agent 2) — см. ниже |
| Тестовый ETH на Base Sepolia | Оплата gas транзакций |
| Тестовый USDC на Base Sepolia | $0.01 за каждую конвертацию |

---

## Шаг 1 — Получи OpenAI API Key

1. Зайди на **https://platform.openai.com/api-keys**
2. Нажми **"Create new secret key"**, скопируй ключ
3. Убедись, что API-проект имеет доступ к GPT Image 2 и положительный баланс

---

## Шаг 2 — Установи MetaMask, создай два кошелька

Нужно **два отдельных кошелька** (один для платежей, другой для владения агентом):

1. Скачай MetaMask: **https://metamask.io/download/**
2. Создай первый аккаунт — **"Agent 1 Payer"**
3. Нажми иконку аккаунта → **Add account or hardware wallet** → **Add a new account**
4. Назови его **"Agent 2 Owner"**
5. Для каждого аккаунта: **Account Details → Show private key** → скопируй ключ

> Почему два кошелька: ERC-8004 Reputation Registry запрещает self-feedback.
> Если платит и владеет агентом один кошелёк — шаг репутации будет пропущен.

---

## Шаг 3 — Добавь Base Sepolia в MetaMask

Зайди на **https://chainlist.org**, включи Testnets, найди **Base Sepolia**, нажми **Add to MetaMask**.

Или вручную (Settings → Networks → Add):

| Поле | Значение |
|---|---|
| Network Name | Base Sepolia |
| RPC URL | `https://sepolia.base.org` |
| Chain ID | `84532` |
| Currency Symbol | `ETH` |
| Block Explorer | `https://sepolia.basescan.org` |

---

## Шаг 4 — Получи тестовый ETH

Нужен на оба кошелька (Agent 1 Payer + Agent 2 Owner):

- **Alchemy**: https://www.alchemy.com/faucets/base-sepolia — 0.1 ETH/день
- **Superchain Faucet**: https://app.optimism.io/faucet — без регистрации

---

## Шаг 5 — Получи тестовый USDC

Только для **Agent 1 Payer** (платит за конвертацию):

1. Зайди на **https://faucet.circle.com**
2. Выбери **Base Sepolia**
3. Вставь адрес Agent 1 Payer
4. Нажми Send — придёт 10 USDC (хватит на 1000 вызовов)

Чтобы USDC отображался в MetaMask: Tokens → Import token →
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`

---

## Шаг 6 — Заполни .env файлы

```bash
cp image-generator/.env.example  image-generator/.env
cp erc8004/.env.example          erc8004/.env
```

### image-generator/.env

```dotenv
OPENAI_API_KEY=sk-...           # ключ из Шага 1
PAYER_PRIVATE_KEY=0x...         # приватный ключ "Agent 1 Payer"
COLORIZER_URL=                  # ОСТАВИТЬ ПУСТЫМ — используется ERC-8004 discovery
```

On-chain репутацию Agent 1 подписывает уже указанным `PAYER_PRIVATE_KEY`.
`PINATA_JWT` и ключ владельца Agent 2 задаются в `erc8004/.env` ниже.

### erc8004/.env (нужен только для перерегистрации агентов)

```dotenv
PINATA_JWT=eyJ...
ERC8004_PRIVATE_KEY=0x...       # приватный ключ "Agent 2 Owner" (ОТЛИЧАЕТСЯ от PAYER!)
BASE_SEPOLIA_RPC=https://sepolia.base.org
```

> **Colorizer-service не нужно настраивать** — он уже задеплоен на Railway.

---

## Шаг 7 — Проверь настройку

```bash
cd image-generator
npm run check
```

Проверит: env переменные, валидность ключей, ETH баланс.

```bash
cd erc8004
npm run check
```

Проверит: env переменные, ETH баланс signer кошелька, доступность IdentityRegistry, Pinata JWT.
Выведет `⚠ WALLET CONFLICT DETECTED` если `PAYER_PRIVATE_KEY` совпадает с `ERC8004_PRIVATE_KEY`.

---

## Шаг 8 — Запуск

```bash
cd image-generator
npm start "a golden retriever in a sunlit meadow"
```

Ожидаемый вывод:

```
=== image-generator ===
Prompt: "a golden retriever in a sunlit meadow"

Discovering Agent 2 via ERC-8004 registry...
  ✓ Discovered: https://erc8004-agent-demo-production.up.railway.app/agent (agentId: 2214)

[1/5] Generating image with GPT Image 2...
  ✓ Image generated (≈38 KB as base64)

[2/5] Sending to colorizer-service (Agent 2)...
  → POST https://erc8004-agent-demo-production.up.railway.app/agent

Агент 2 запрашивает оплату $0.01 USDC на Base Sepolia. Подтвердить? (y/n) > y
  → Подписываю платёж (EIP-3009)...
  → Повторный запрос с PAYMENT-SIGNATURE заголовком...
  ✓ Grayscale image received

[3/5] Saving output.jpg...
[4/5] Recording ERC-8004 reputation feedback...
  ✓ Feedback recorded
[5/5] Submitting ERC-8004 validation request...
  ✓ Validation request recorded on-chain
  ✓ Independent validation response submitted

=== Done ===
✓ Saved to: output.jpg
✓ Payment txHash: 0x...
```

---

## Troubleshooting

| Ошибка | Причина | Решение |
|---|---|---|
| `Agent 2 not found in ERC-8004 registry` | agentId не найден | `cd erc8004 && npm run discover` |
| `PAYER_PRIVATE_KEY not set` | Не заполнен .env | Повтори Шаг 6 |
| `Address "0x..." is invalid` | Неверный `PAYMENT_RECIPIENT_ADDRESS` | Проверь Railway Variables |
| `Payment rejected` | Нет USDC на кошельке | Повтори Шаг 5 |
| `Reputation feedback skipped` | Одинаковые кошельки | Используй два разных ключа |
| `DALL-E: insufficient_quota` | Нет кредитов OpenAI | Пополни баланс |


---

## Публичный сайт и домен

Для сайта разверните папку `frontend` как отдельный Railway service, перенесите
переменные из `frontend/.env.example` и задайте `SERVICE_ACCESS_TOKEN`.
После успешного healthcheck `/health` добавьте домен в Railway Networking и
создайте CNAME-запись, которую покажет Railway. Полная инструкция:
`docs/CUSTOM_DOMAIN.md`.

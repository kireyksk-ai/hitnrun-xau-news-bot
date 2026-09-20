$ErrorActionPreference = "Stop"

function Read-SecretText([string] $Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Escape-EnvValue([string] $Value) { return '"' + $Value.Replace('"', '\"') + '"' }

Write-Host "HitnRun XAU News Bot - setup aman" -ForegroundColor Cyan
Write-Host "Key yang diketik tidak akan terlihat di layar." -ForegroundColor DarkGray
$openAiKey = Read-SecretText "Tempel OpenAI API key, lalu Enter"
$telegramToken = Read-SecretText "Tempel token bot Telegram BARU, lalu Enter"
$newsApiKey = Read-SecretText "Tempel NewsAPI key, lalu Enter"

$envFile = Join-Path $PSScriptRoot ".env"
@(
  "OPENAI_API_KEY=$(Escape-EnvValue $openAiKey)",
  "TELEGRAM_BOT_TOKEN=$(Escape-EnvValue $telegramToken)",
  "TELEGRAM_CHAT_ID=",
  "NEWSAPI_KEY=$(Escape-EnvValue $newsApiKey)",
  "OPENAI_MODEL=gpt-5-mini",
  "OPENAI_REASONING_EFFORT=high",
  "POLL_INTERVAL_SECONDS=45",
  "TRUTH_SOCIAL_ENABLED=false",
  "TRUTH_SOCIAL_POLL_SECONDS=15",
  "MAX_ARTICLE_AGE_MINUTES=20",
  "SQLITE_PATH=./data/bot-store",
  "LOG_LEVEL=info"
) | Set-Content -Path $envFile -Encoding utf8

Write-Host "`nSelesai. File rahasia .env sudah dibuat." -ForegroundColor Green
Write-Host "Jangan kirim file .env ke siapa pun." -ForegroundColor Yellow

# Liga o eccö RADAR no Windows. Quem chama este arquivo é o "Iniciar RADAR (Windows).bat".
# Na primeira vez ele cria as configurações, monta o app e pede uma senha para o seu login.
# Nada aqui publica nada em lugar nenhum; o RADAR fica só em http://localhost:8787.
Set-Location (Split-Path -Parent $PSScriptRoot)

function Say($text) { Write-Host ""; Write-Host $text -ForegroundColor Cyan }
function Fail($text) {
  Write-Host ""; Write-Host $text -ForegroundColor Red
  Read-Host "Aperte Enter para fechar" | Out-Null
  exit 1
}
function New-Hex([int]$bytes) {
  $buffer = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  ($buffer | ForEach-Object { $_.ToString('x2') }) -join ''
}
function Test-Docker { docker info *> $null; return ($LASTEXITCODE -eq 0) }

Say "eccö RADAR: ligando..."

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Start-Process "https://www.docker.com/products/docker-desktop/"
  Fail "O Docker Desktop não está instalado. Abri a página de download: instale, reinicie o computador se ele pedir, abra o Docker uma vez e clique de novo no arquivo Iniciar."
}

if (-not (Test-Docker)) {
  Say "Abrindo o Docker Desktop (pode levar um ou dois minutos)..."
  $desktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
  if (Test-Path $desktop) { Start-Process $desktop }
  for ($i = 0; $i -lt 90; $i++) { if (Test-Docker) { break }; Start-Sleep -Seconds 2 }
  if (-not (Test-Docker)) { Fail "O Docker não respondeu. Abra o Docker Desktop, espere ele dizer que está rodando (Engine running) e clique de novo no arquivo Iniciar." }
}

if (-not (Test-Path ".env")) {
  Say "Primeira vez: criando as configurações."
  $email = (Read-Host "Seu e-mail (vai ser o seu login no RADAR)").Trim()
  if (-not $email) { Fail "Preciso de um e-mail. Clique de novo no arquivo para recomeçar." }
  $lines = @(
    '# Criado pelo "Iniciar RADAR (Windows).bat". Guarde este arquivo só no seu computador.',
    "SESSION_SECRET=$(New-Hex 32)",
    'APP_ORIGIN=http://localhost:8787',
    'PORT=8787',
    "POSTGRES_PASSWORD=$(New-Hex 16)",
    "SOURCE_CONTACT=$email",
    "RADAR_LOGIN=$email",
    'FLICKR_API_KEY=',
    'TUMBLR_API_KEY=',
    'ANTHROPIC_API_KEY=',
    'ANTHROPIC_MODEL=claude-opus-5-5'
  )
  # LF line endings and no BOM, so Docker reads it the same way as on Mac and Linux.
  [IO.File]::WriteAllText((Join-Path (Get-Location) ".env"), (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
}

Say "Montando e ligando o RADAR. Na primeira vez isso leva alguns minutos..."
docker compose up -d --build --wait
if ($LASTEXITCODE -ne 0) { Fail "Algo deu errado ao ligar. Tire um print desta janela e mande para a Claude." }

$users = (docker compose exec -T db psql -U radar -d radar -Atc "SELECT count(*) FROM users" 2> $null | Out-String).Trim()
if (-not $users) { $users = "0" }
if ($users -eq "0") {
  $login = ((Get-Content ".env" | Where-Object { $_ -like "RADAR_LOGIN=*" } | Select-Object -First 1) -replace '^RADAR_LOGIN=', '').Trim()
  if (-not $login) { $login = (Read-Host "Seu e-mail para o login").Trim() }
  Say "Crie a senha do seu login ($login). Mínimo de 12 caracteres; ela não aparece enquanto você digita."
  while ($true) {
    $s1 = Read-Host "Senha" -AsSecureString
    $s2 = Read-Host "Repita a senha" -AsSecureString
    $p1 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s1))
    $p2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s2))
    if ($p1 -cne $p2) { Write-Host "As senhas não são iguais. Tente de novo."; continue }
    if ($p1.Length -lt 12) { Write-Host "A senha precisa ter pelo menos 12 caracteres."; continue }
    break
  }
  # The password reaches the app only through an environment variable, never the command line.
  $env:RADAR_PASSWORD = $p1
  docker compose exec -T -e RADAR_PASSWORD app node dist/auth/create-user-cli.js $login "Arthur"
  $created = $LASTEXITCODE
  Remove-Item Env:RADAR_PASSWORD
  $p1 = $null; $p2 = $null
  if ($created -ne 0) { Fail "Não consegui criar o login. Tire um print desta janela e mande para a Claude." }
}

Say "Pronto! Abrindo http://localhost:8787 no navegador."
Start-Process "http://localhost:8787"
Write-Host 'Use o Chrome, o Edge ou o Firefox. Para desligar o RADAR, clique duas vezes em "Parar RADAR (Windows).bat".'
Read-Host "Pode fechar esta janela (ou aperte Enter)" | Out-Null

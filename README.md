# França — Comunidade ao vivo

Site estático (HTML, CSS e JS puro) que mostra **quem está ao vivo** na Kick e na Twitch.
Atualiza sozinho, avisa no navegador quando alguém entra no ar e leva direto ao canal.

## Como funciona

Duas camadas:

1. **Tempo real (Kick):** a API da Kick libera CORS para o site, então o próprio navegador
   consulta cada canal a cada 60 segundos. É isso que deixa o status quase instantâneo.
2. **Backup + Twitch:** um GitHub Action roda `scripts/update-live.mjs` a cada 5 minutos e
   grava `data/live.json`. Serve de base para o primeiro carregamento e é a única fonte
   para os canais da Twitch (que exigem credenciais de servidor).

```
data/streamers.json   →  lista de streamers (você edita isso)
        ↓
GitHub Action (5 min) →  scripts/update-live.mjs  →  data/live.json
        ↓                                              ↓
site (index.html)  ←  consulta a Kick direto no navegador (tempo real) + data/live.json
```

Se a Kick bloquear a consulta direta (rede do visitante), o site cai automaticamente para
os dados do `data/live.json` — nada quebra.

## Estrutura

```
.
├── index.html                  # página principal
├── data/
│   ├── streamers.json          # lista de streamers + link do Discord
│   └── live.json               # status ao vivo (gerado pelo script)
├── scripts/update-live.mjs     # consulta Kick/Twitch e grava data/live.json
├── .github/workflows/live.yml  # agenda a atualização a cada 5 minutos
├── assets/
│   ├── css/style.css
│   ├── js/main.js
│   └── img/                    # favicon e imagem de compartilhamento
└── README.md
```

## Adicionar ou remover streamer

Edite **`data/streamers.json`** e adicione um bloco:

```json
{
  "id": "nomedocanal",
  "nome": "Nome que aparece no site",
  "plataforma": "kick",
  "slug": "nomedocanal",
  "url": "https://kick.com/nomedocanal",
  "destaque": false
}
```

- `plataforma`: `kick`, `twitch` ou `x`
- `slug`: o nome usado na URL do canal (sem `/`)
- `id`: identificador único — se mudar, o histórico de status se perde
- Para canais sem status ao vivo (como X), adicione `"aoVivoSuportado": false`

Commitou, o site atualiza sozinho. O status leva até 5 minutos para refletir.

## Link do Discord

Fica em `data/streamers.json`:

```json
"comunidade": { "discord": "https://discord.gg/SEU-CONVITE" }
```

Todos os botões marcados com `data-discord` no HTML pegam esse valor.

## Rodar localmente

O site usa `fetch` para ler os arquivos JSON, então precisa de um servidor local
(abrir o arquivo direto no navegador não funciona):

```bash
npx serve .
# abre em http://localhost:3000
```

Para atualizar o status manualmente:

```bash
node scripts/update-live.mjs
```

### Cache do GitHub Pages

O Pages guarda CSS e JS por ~10 minutos. Depois de mexer em `style.css` ou `main.js`,
troque o `?v=2` no `index.html` por `?v=3`, `?v=4`… para os visitantes receberem a versão nova na hora.

## Twitch (opcional)

A Kick funciona sem nenhuma configuração. Para a Twitch, crie um app em
<https://dev.twitch.tv/console/apps> e cadastre dois secrets no repositório
(**Settings → Secrets and variables → Actions**):

| Secret | Valor |
|---|---|
| `TWITCH_CLIENT_ID` | Client ID do app |
| `TWITCH_CLIENT_SECRET` | Client Secret do app |

Sem esses secrets, canais da Twitch aparecem como "status indisponível" (o link continua funcionando).

## Publicar no GitHub Pages

1. Suba o repositório.
2. **Settings → Pages** → *Deploy from a branch*.
3. Branch `main`, pasta `/ (root)`, salvar.
4. Site em `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

> A Action de status grava no próprio repositório, então a branch `main` precisa aceitar push
> do `github-actions[bot]` (é o padrão). Se houver proteção de branch, libere esse bot.

## Limitações conhecidas

- **Notificações** só aparecem com o site aberto em alguma aba (limitação do navegador sem servidor de push).
- **X/Twitter** não tem API pública de status de live — o perfil entra apenas como link.
- A API usada para a Kick é a mesma que o site oficial usa, não é documentada. Se mudar,
  o script mantém o último status conhecido em vez de zerar tudo.

Não afiliado à Kick, Twitch ou X.

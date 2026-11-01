# Graded Reader EN

App para estudar inglês com graded readers: histórias por nível (A2–C1), leitura com áudio, toque numa palavra para ver o significado, lista de palavras com revisão espaçada e importação dos seus próprios textos com MP3.

- **Hospedagem:** GitHub Pages (grátis)
- **Dados e áudio:** Supabase (login, banco de dados e armazenamento de arquivos)
- **Sincronização ao vivo** entre PC e celular
- **Offline:** o app abre sem internet, e cada áudio fica guardado no aparelho depois da primeira vez que você o ouve

---

## Configuração (uns 20 minutos, uma vez só)

### 1. Criar o projeto no Supabase
1. Crie uma conta em [supabase.com](https://supabase.com) (dá para entrar com a conta do GitHub).
2. Clique em **New project**. Escolha um nome (ex.: `graded-reader-en`), defina uma senha para o banco (guarde-a) e escolha uma região na Europa, como Ireland ou Frankfurt.
3. Espere 1–2 minutos até o projeto ficar pronto.

### 2. Criar as tabelas e o espaço para os áudios
1. No menu lateral, abra **SQL Editor** → **New query**.
2. Copie todo o conteúdo do arquivo `supabase/schema.sql`, cole e clique em **Run**.
3. Deve aparecer "Success". Isso cria as tabelas de textos, progresso e palavras, as regras de segurança (cada pessoa só vê os próprios dados), a sincronização ao vivo e a pasta privada `audio`.

### 3. Pegar as chaves e colocar no app
1. Clique no botão **Connect** no topo do painel (ou vá em **Project Settings → API Keys**) e copie:
   - **Project URL** (`https://xxxx.supabase.co`)
   - **Publishable key** (começa com `sb_publishable_`). Em projetos antigos, a equivalente é a **anon public**, na aba *Legacy API Keys*.
2. Abra o arquivo `config.js` e substitua os dois valores.

A chave *publishable* pode ficar pública. As regras de segurança do banco garantem que cada conta só acessa os próprios dados. **Nunca** coloque no app a chave *secret* (`sb_secret_`) nem a `service_role`.

### 4. Publicar no GitHub Pages
1. No GitHub, crie um repositório novo, por exemplo `graded-reader-en`. Para o GitHub Pages ser grátis, ele precisa ser **público**.
2. Na página do repositório: **Add file → Upload files** e arraste todos os arquivos e pastas deste projeto (`index.html`, `app.js`, `styles.css`, `config.js`, `stories.js`, `sw.js`, `manifest.webmanifest`, a pasta `icons` e a pasta `supabase`). Clique em **Commit changes**.
3. Vá em **Settings → Pages**. Em *Source*, escolha **Deploy from a branch**, branch **main**, pasta **/ (root)** e clique em **Save**.
4. Em 1–2 minutos o app fica disponível em `https://SEU-USUARIO.github.io/graded-reader-en/`.

### 5. Ligar o login ao endereço do app
1. No Supabase, abra **Authentication → URL Configuration**.
2. Em **Site URL**, coloque o endereço do GitHub Pages do passo anterior.
3. Em **Redirect URLs**, adicione o mesmo endereço.
4. Opcional, mas mais simples para uso pessoal: em **Authentication → Sign In / Providers → Email**, desative **Confirm email**. Assim a conta funciona na hora, sem precisar abrir o email de confirmação.

### 6. Usar
1. Abra o endereço do app e clique em **Create an account**.
2. No celular, instale como app:
   - **iPhone (Safari):** botão Compartilhar → **Adicionar à Tela de Início**
   - **Android (Chrome):** menu ⋮ → **Instalar app**
3. Entre com a mesma conta no PC e no celular. Palavras, progresso e textos sincronizam ao vivo.

---

## Como usar

- **Library:** histórias por nível. As palavras sublinhadas a ponteado têm significado e tradução prontos.
- **Toque numa palavra:** para salvá-la, com a frase onde apareceu. Para palavras sem significado pronto, preencha você mesmo ou use os atalhos para o Cambridge Dictionary e o Google Tradutor.
- **Áudio:**
  - Textos sem MP3 são lidos pela voz do aparelho, com a frase atual destacada. Dois cliques numa frase começam a leitura dali.
  - Textos com MP3 tocam a gravação, com controles de ±10 s, velocidade e controle pela tela de bloqueio.
- **Add:** cole um texto ou carregue um .txt ou .pdf, e junte o MP3 (até 50 MB). Também dá para adicionar ou trocar o áudio depois, dentro do texto.
- **Words:** lista de palavras e revisão em flashcards. Cada acerto aumenta o intervalo: 1, 3, 7, 16 e depois 35 dias.

## Atualizar o app

1. Edite os arquivos no GitHub (ou envie de novo).
2. Em `sw.js`, aumente o número em `const VERSION = "gre-v1"` (por exemplo, para `gre-v2`). Assim os celulares baixam a versão nova.

Para adicionar histórias fixas, edite `stories.js` seguindo o formato das que já existem.

## Limites do plano gratuito do Supabase

- 1 GB para arquivos. Episódios de podcast costumam ter 5–10 MB cada.
- 500 MB de banco de dados.
- Projetos gratuitos são **pausados após 1 semana sem uso**. Se acontecer, entre no painel do Supabase e clique em **Restore**. Os dados não se perdem.

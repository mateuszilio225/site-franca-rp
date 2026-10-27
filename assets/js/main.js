/* ==========================================================
   França — Comunidade ao vivo
   Carrega os streamers, consulta o status ao vivo e avisa
   quando alguém entra no ar.
   ========================================================== */
(function () {
  "use strict";

  const ARQUIVO_STREAMERS = "data/streamers.json";
  const ARQUIVO_LIVE = "data/live.json";
  const INTERVALO_ATUALIZACAO = 60 * 1000; // 60s
  const CHAVE_AVISADOS = "franca-rp:avisados";

  const estado = {
    config: null,
    live: null,
    filtro: "todos",
    metrica: "viewers-desc",
    categoria: "todas",
    metricaInicialDefinida: false,
    aoVivoAntes: new Set(),
    primeiraCarga: true,
  };

  const $ = (sel) => document.querySelector(sel);
  const numero = new Intl.NumberFormat("pt-BR");

  const escapar = (valor) =>
    String(valor ?? "").replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
    );

  const formatarNumero = (valor) => numero.format(Number(valor) || 0);

  const formatarDuracao = (iso) => {
    if (!iso) return "";
    const inicio = new Date(iso).getTime();
    if (!Number.isFinite(inicio)) return "";
    const minutos = Math.floor((Date.now() - inicio) / 60000);
    if (minutos < 1) return "agora";
    if (minutos < 60) return `há ${minutos} min`;
    const horas = Math.floor(minutos / 60);
    const resto = minutos % 60;
    return resto ? `há ${horas}h${String(resto).padStart(2, "0")}` : `há ${horas}h`;
  };

  const iniciais = (nome) =>
    String(nome || "?")
      .replace(/[^\p{L}\p{N} ]/gu, "")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((parte) => parte[0] || "")
      .join("")
      .toUpperCase();

  const iconeOlho = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;

  /* ---------- Dados ---------- */

  const buscarJson = async (arquivo) => {
    const resposta = await fetch(`${arquivo}?t=${Date.now()}`, { cache: "no-store" });
    if (!resposta.ok) throw new Error(`${arquivo}: HTTP ${resposta.status}`);
    return resposta.json();
  };

  /** "2026-10-23 17:15:06" (UTC) -> ISO */
  const paraIso = (valor) => {
    if (!valor) return null;
    const normalizado = String(valor).replace(" ", "T");
    const comFuso = /Z$|[+-]\d{2}:\d{2}$/.test(normalizado) ? normalizado : `${normalizado}Z`;
    const data = new Date(comFuso);
    return Number.isNaN(data.getTime()) ? null : data.toISOString();
  };

  /**
   * A API da Kick libera CORS para o site, então dá para consultar o status
   * ao vivo direto do navegador — sem esperar o GitHub Actions.
   */
  const buscarKickDireto = async (streamer) => {
    const slug = streamer.slug || streamer.id;
    const resposta = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });

    if (!resposta.ok) throw new Error(`Kick HTTP ${resposta.status}`);

    const dados = await resposta.json();
    const live = dados?.livestream;

    return {
      plataforma: "kick",
      aoVivo: Boolean(live),
      espectadores: Number(live?.viewer_count ?? 0),
      titulo: live?.session_title ?? "",
      categoria: live?.categories?.[0]?.name ?? "",
      iniciadoEm: paraIso(live?.start_time),
      thumb: live?.thumbnail?.url ?? "",
      seguidores: Number(dados?.followers_count ?? 0),
      avatar: dados?.user?.profile_pic ?? "",
    };
  };

  const atualizarKickAoVivo = async () => {
    const canais = (estado.config?.streamers ?? []).filter(
      (streamer) => streamer.plataforma === "kick" && streamer.aoVivoSuportado !== false
    );

    const resultados = await Promise.allSettled(
      canais.map(async (streamer) => [streamer.id, await buscarKickDireto(streamer)])
    );

    let atualizados = 0;

    for (const resultado of resultados) {
      if (resultado.status !== "fulfilled") continue;
      const [id, dados] = resultado.value;
      estado.live.streamers[id] = { ...(estado.live.streamers[id] ?? {}), ...dados };
      atualizados += 1;
    }

    return atualizados;
  };

  const streamerPorId = (id) =>
    (estado.config?.streamers ?? []).find((streamer) => streamer.id === id);

  const statusDe = (id) => estado.live?.streamers?.[id] ?? null;

  const aoVivo = () =>
    Object.entries(estado.live?.streamers ?? {})
      .filter(([, status]) => status?.aoVivo)
      .map(([id, status]) => ({ streamer: streamerPorId(id), live: status }))
      .filter((item) => Boolean(item.streamer))
      .sort((a, b) => (b.live.espectadores || 0) - (a.live.espectadores || 0));

  /* ---------- Render ---------- */

  const etiquetaPlataforma = (plataforma) => {
    const mapa = {
      kick: { texto: "Kick", classe: "plat-kick" },
      twitch: { texto: "Twitch", classe: "plat-twitch" },
      x: { texto: "X", classe: "plat-x" },
    };
    const info = mapa[plataforma] ?? { texto: plataforma, classe: "" };
    return `<span class="plat ${info.classe}">${escapar(info.texto)}</span>`;
  };

  const avatarHtml = (streamer, live) => {
    const foto = live?.avatar;
    return foto
      ? `<span class="streamer-avatar"><img src="${escapar(foto)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" /><span class="status-dot"></span></span>`
      : `<span class="streamer-avatar">${escapar(iniciais(streamer.nome))}<span class="status-dot"></span></span>`;
  };

  const cartaoAoVivo = ({ streamer, live }) => `
    <a class="live-card" href="${escapar(streamer.url)}" target="_blank" rel="noopener">
      ${
        live.avatar
          ? `<img class="live-avatar-lg" src="${escapar(live.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />`
          : `<span class="live-avatar-lg is-iniciais">${escapar(iniciais(streamer.nome))}</span>`
      }
      <div class="live-info">
        <div class="live-name-row">
          <strong>${escapar(streamer.nome)}</strong>
          <span class="badge-live"><i></i>Ao vivo</span>
          ${etiquetaPlataforma(streamer.plataforma)}
        </div>
        <p class="live-title">${escapar(live.titulo || "Transmitindo ao vivo")}</p>
        <div class="live-foot">
          <span class="badge-viewers">${iconeOlho}${formatarNumero(live.espectadores)}</span>
          ${live.categoria ? `<span class="sep">•</span><span>${escapar(live.categoria)}</span>` : ""}
          ${live.iniciadoEm ? `<span class="sep">•</span><span>${escapar(formatarDuracao(live.iniciadoEm))}</span>` : ""}
        </div>
      </div>
    </a>
  `;

  const cartaoStreamer = (streamer) => {
    const live = statusDe(streamer.id);
    const estaAoVivo = Boolean(live?.aoVivo);
    const semStatus = Boolean(live?.semStatusAoVivo);

    let subtitulo;
    if (estaAoVivo) {
      subtitulo = `${formatarNumero(live.espectadores)} assistindo • ${formatarDuracao(live.iniciadoEm)}`;
    } else if (semStatus) {
      subtitulo = "Status indisponível nesta plataforma";
    } else if (live?.seguidores) {
      subtitulo = `${formatarNumero(live.seguidores)} seguidores`;
    } else {
      subtitulo = "Offline no momento";
    }

    const rotulo =
      streamer.plataforma === "x" ? "Ver perfil" : estaAoVivo ? "Assistir agora" : "Abrir canal";

    return `
      <article class="streamer${estaAoVivo ? " is-live" : ""}" data-plataforma="${escapar(streamer.plataforma)}">
        <div class="streamer-top">
          ${avatarHtml(streamer, live)}
          ${etiquetaPlataforma(streamer.plataforma)}
        </div>
        <div>
          <h3 title="${escapar(streamer.nome)}">${escapar(streamer.nome)}</h3>
          <p class="streamer-sub${estaAoVivo ? " is-live-text" : ""}">${escapar(subtitulo)}</p>
        </div>
        <div class="streamer-actions">
          <a class="btn btn-ghost btn-sm" href="${escapar(streamer.url)}" target="_blank" rel="noopener">${rotulo}</a>
        </div>
      </article>
    `;
  };

  const renderAoVivo = () => {
    const grade = $("#gradeAoVivo");
    const vazio = $("#vazioAoVivo");
    if (!grade || !vazio) return;

    grade.setAttribute("aria-busy", "false");
    const lives = aoVivo();

    grade.innerHTML = lives.map(cartaoAoVivo).join("");
    grade.hidden = lives.length === 0;
    vazio.hidden = lives.length > 0;
  };

  const renderStreamers = () => {
    const lista = $("#listaStreamers");
    if (!lista || !estado.config) return;

    lista.setAttribute("aria-busy", "false");

    const streamers = estado.config.streamers
      .filter((streamer) => estado.filtro === "todos" || streamer.plataforma === estado.filtro)
      .sort(
        (a, b) =>
          Number(Boolean(statusDe(b.id)?.aoVivo)) - Number(Boolean(statusDe(a.id)?.aoVivo))
      );

    lista.innerHTML = streamers.length
      ? streamers.map(cartaoStreamer).join("")
      : `<p class="lead">Nenhum streamer nessa plataforma ainda.</p>`;
  };

  const renderEstatisticas = () => {
    const lives = aoVivo();
    const total = estado.config?.streamers?.length ?? 0;
    const espectadores = lives.reduce((soma, item) => soma + (item.live.espectadores || 0), 0);

    const alvos = {
      statTotal: formatarNumero(total),
      statAoVivo: formatarNumero(lives.length),
      statEspectadores: formatarNumero(espectadores),
    };

    for (const [id, valor] of Object.entries(alvos)) {
      const elemento = document.getElementById(id);
      if (elemento) elemento.textContent = valor;
    }

    document.title = lives.length
      ? `🔴 ${lives.length} ao vivo • França`
      : "França — Comunidade ao vivo";
  };

  const renderAtualizacao = () => {
    const alvo = $("#updateTime");
    if (!alvo) return;

    if (estado.live?.direto) {
      alvo.textContent = "atualizado agora • direto da Kick";
      return;
    }

    const gerado = estado.live?.geradoEm ? new Date(estado.live.geradoEm) : null;

    if (!gerado || Number.isNaN(gerado.getTime())) {
      alvo.textContent = "atualização automática";
      return;
    }

    const quando = formatarDuracao(gerado.toISOString()) || "agora";
    alvo.textContent = `status ${quando} • atualiza a cada minuto`;
  };

  /* ---------- Métricas / ranking ---------- */

  const METRICAS = {
    "viewers-desc": { chave: "espectadores", ordem: "desc", aoVivo: true, rotulo: "assistindo" },
    "viewers-asc": { chave: "espectadores", ordem: "asc", aoVivo: true, rotulo: "assistindo" },
    "seguidores-desc": { chave: "seguidores", ordem: "desc", aoVivo: false, rotulo: "seguidores" },
    "seguidores-asc": { chave: "seguidores", ordem: "asc", aoVivo: false, rotulo: "seguidores" },
  };

  const categoriasAoVivo = () => {
    const categorias = new Set();
    Object.values(estado.live?.streamers ?? {}).forEach((status) => {
      if (status?.aoVivo && status.categoria) categorias.add(status.categoria);
    });
    return [...categorias].sort((a, b) => a.localeCompare(b, "pt-BR"));
  };

  const renderCategorias = () => {
    const caixa = document.getElementById("chipsCategoria");
    if (!caixa) return;

    const metrica = METRICAS[estado.metrica] ?? METRICAS["viewers-desc"];
    const categorias = categoriasAoVivo();

    if (estado.categoria !== "todas" && !categorias.includes(estado.categoria)) {
      estado.categoria = "todas";
    }

    caixa.classList.toggle("is-disabled", !metrica.aoVivo);
    caixa.title = metrica.aoVivo
      ? ""
      : "A categoria só existe enquanto o streamer está ao vivo";

    const chips = [
      `<button class="chip chip-categoria${estado.categoria === "todas" ? " is-active" : ""}" data-categoria="todas" type="button">Todas as categorias</button>`,
      ...categorias.map(
        (categoria) =>
          `<button class="chip chip-categoria${estado.categoria === categoria ? " is-active" : ""}" data-categoria="${escapar(categoria)}" type="button">${escapar(categoria)}</button>`
      ),
    ];

    caixa.innerHTML = chips.join("");
  };

  const itensRanking = () => {
    const metrica = METRICAS[estado.metrica] ?? METRICAS["viewers-desc"];

    let itens = (estado.config?.streamers ?? [])
      .filter((streamer) => streamer.aoVivoSuportado !== false)
      .map((streamer) => ({ streamer, live: statusDe(streamer.id) ?? {} }));

    if (metrica.aoVivo) {
      itens = itens.filter((item) => item.live.aoVivo);
      if (estado.categoria !== "todas") {
        itens = itens.filter((item) => item.live.categoria === estado.categoria);
      }
    } else {
      itens = itens.filter((item) => Number(item.live[metrica.chave]) > 0);
    }

    itens.sort((a, b) => {
      const diferenca = (Number(a.live[metrica.chave]) || 0) - (Number(b.live[metrica.chave]) || 0);
      return metrica.ordem === "asc" ? diferenca : -diferenca;
    });

    return itens;
  };

  const renderRanking = () => {
    const lista = document.getElementById("ranking");
    const vazio = document.getElementById("rankingVazio");
    if (!lista) return;

    const metrica = METRICAS[estado.metrica] ?? METRICAS["viewers-desc"];
    const itens = itensRanking();
    const maior = Math.max(...itens.map((item) => Number(item.live[metrica.chave]) || 0), 1);

    lista.setAttribute("aria-busy", "false");
    lista.hidden = itens.length === 0;

    lista.innerHTML = itens
      .map((item, indice) => {
        const valor = Number(item.live[metrica.chave]) || 0;
        const largura = Math.max(6, Math.round((valor / maior) * 100));
        const live = item.live;

        const avatar = live.avatar
          ? `<img class="rank-avatar" src="${escapar(live.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />`
          : `<span class="rank-avatar">${escapar(iniciais(item.streamer.nome))}</span>`;

        const detalhes = metrica.aoVivo
          ? [live.categoria, formatarDuracao(live.iniciadoEm)].filter(Boolean)
          : [];

        const meta = detalhes.length
          ? `<div class="rank-meta">${detalhes
              .map((texto) => escapar(texto))
              .join('<span class="sep">•</span>')}</div>`
          : "";

        return `<li class="rank-item${indice < 3 ? " is-podio" : ""}">
          <span class="rank-pos">${indice + 1}</span>
          ${avatar}
          <div class="rank-info">
            <div class="rank-name"><span>${escapar(item.streamer.nome)}</span>${etiquetaPlataforma(item.streamer.plataforma)}</div>
            <div class="rank-bar"><span style="width:${largura}%"></span></div>
            ${meta}
          </div>
          <span class="rank-value">${formatarNumero(valor)}<small>${metrica.rotulo}</small></span>
        </li>`;
      })
      .join("");

    if (vazio) {
      vazio.hidden = itens.length > 0;
      vazio.textContent = metrica.aoVivo
        ? "Nenhum streamer ao vivo com esses filtros agora."
        : "Ainda não há dados de seguidores para essa seleção.";
    }
  };

  const ligarControlesMetricas = () => {
    const chipsMetrica = document.getElementById("chipsMetrica");
    chipsMetrica?.addEventListener("click", (evento) => {
      const botao = evento.target.closest(".chip");
      if (!botao) return;
      estado.metrica = botao.dataset.metrica || "viewers-desc";
      chipsMetrica
        .querySelectorAll(".chip")
        .forEach((chip) => chip.classList.toggle("is-active", chip === botao));
      renderCategorias();
      renderRanking();
    });

    const chipsCategoria = document.getElementById("chipsCategoria");
    chipsCategoria?.addEventListener("click", (evento) => {
      const botao = evento.target.closest(".chip");
      if (!botao) return;
      estado.categoria = botao.dataset.categoria || "todas";
      renderCategorias();
      renderRanking();
    });
  };

  /* ---------- Notificações ---------- */

  const botoesNotif = () =>
    ["btnNotifTop", "btnNotif", "btnNotifEmpty", "btnNotifCta"]
      .map((id) => document.getElementById(id))
      .filter(Boolean);

  const notificacoesAtivas = () =>
    "Notification" in window && Notification.permission === "granted";

  const atualizarBotoesNotif = () => {
    const ativo = notificacoesAtivas();

    for (const botao of botoesNotif()) {
      botao.classList.toggle("is-on", ativo);
      const ponto = botao.querySelector(".icon-btn-dot");
      if (ponto) ponto.hidden = !ativo;

      if (botao.id === "btnNotifTop") {
        botao.setAttribute("aria-label", ativo ? "Notificações ativadas" : "Ativar notificações de live");
        botao.title = ativo ? "Notificações ativadas" : "Ativar notificações de live";
      } else if (ativo) {
        botao.textContent = "Notificações ativadas";
      } else if (botao.id === "btnNotifEmpty") {
        botao.textContent = "Me avise quando começar";
      } else {
        botao.textContent = "Ativar notificações";
      }
    }
  };

  const lerAvisados = () => {
    try {
      const bruto = JSON.parse(localStorage.getItem(CHAVE_AVISADOS) || "[]");
      return new Set(Array.isArray(bruto) ? bruto : []);
    } catch {
      return new Set();
    }
  };

  const salvarAvisados = (conjunto) => {
    try {
      const lista = Array.from(conjunto).slice(-120);
      localStorage.setItem(CHAVE_AVISADOS, JSON.stringify(lista));
    } catch {
      /* localStorage indisponível: segue sem persistir */
    }
  };

  const mostrarToast = ({ streamer, live }) => {
    const caixa = $("#toasts");
    if (!caixa) return;

    const aviso = document.createElement("a");
    aviso.className = "toast";
    aviso.href = streamer.url;
    aviso.target = "_blank";
    aviso.rel = "noopener";
    aviso.innerHTML = `
      ${
        live.avatar
          ? `<img class="toast-avatar" src="${escapar(live.avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()" />`
          : ""
      }
      <span>
        <strong>${escapar(streamer.nome)} está ao vivo!</strong>
        <span>${escapar(live.titulo || "Clique para assistir")}</span>
      </span>
    `;

    caixa.appendChild(aviso);
    setTimeout(() => aviso.remove(), 12000);
  };

  const avisar = (novas) => {
    if (!novas.length) return;

    const avisados = lerAvisados();

    for (const item of novas) {
      const chave = `${item.streamer.id}:${item.live.iniciadoEm || "sem-data"}`;

      if (!estado.primeiraCarga) {
        mostrarToast(item);

        if (notificacoesAtivas() && !avisados.has(chave)) {
          try {
            const notificacao = new Notification(`${item.streamer.nome} está ao vivo!`, {
              body: item.live.titulo || "Clique para assistir",
              icon: item.live.avatar || undefined,
              tag: item.streamer.id,
            });
            notificacao.onclick = () => {
              window.open(item.streamer.url, "_blank", "noopener");
              notificacao.close();
            };
          } catch {
            /* alguns navegadores exigem service worker; o toast já avisou */
          }
        }
      }

      avisados.add(chave);
    }

    salvarAvisados(avisados);
    estado.primeiraCarga = false;
  };

  const pedirPermissao = async () => {
    if (!("Notification" in window)) {
      mostrarToastSimples("Seu navegador não suporta notificações.");
      return;
    }

    if (Notification.permission === "granted") {
      atualizarBotoesNotif();
      mostrarToastSimples("As notificações já estão ativadas. Te aviso quando alguém entrar ao vivo.");
      return;
    }

    if (Notification.permission === "denied") {
      mostrarToastSimples("As notificações estão bloqueadas nas configurações do navegador.");
      return;
    }

    const permissao = await Notification.requestPermission();
    atualizarBotoesNotif();

    if (permissao === "granted") {
      mostrarToastSimples("Pronto! Você será avisado quando alguém abrir live.");
    } else {
      mostrarToastSimples("Sem problema — você ainda vê quem está ao vivo por aqui.");
    }
  };

  const mostrarToastSimples = (mensagem) => {
    const caixa = $("#toasts");
    if (!caixa) return;

    const aviso = document.createElement("div");
    aviso.className = "toast";
    aviso.innerHTML = `<span><strong>${escapar(mensagem)}</strong></span>`;
    caixa.appendChild(aviso);
    setTimeout(() => aviso.remove(), 9000);
  };

  /* ---------- Ciclo de atualização ---------- */

  const compararAoVivo = () => {
    const agora = new Set(aoVivo().map((item) => item.streamer.id));
    const novas = aoVivo().filter((item) => !estado.aoVivoAntes.has(item.streamer.id));
    estado.aoVivoAntes = agora;
    return novas;
  };

  const definirMetricaInicial = () => {
    if (estado.metricaInicialDefinida) return;
    estado.metricaInicialDefinida = true;

    // Ninguém ao vivo? Mostra o ranking por seguidores para a seção não ficar vazia.
    if (aoVivo().length > 0) return;

    estado.metrica = "seguidores-desc";
    const chips = document.getElementById("chipsMetrica");
    chips?.querySelectorAll(".chip").forEach((chip) => {
      chip.classList.toggle("is-active", chip.dataset.metrica === estado.metrica);
    });
  };

  const atualizarInterface = () => {
    definirMetricaInicial();
    renderAoVivo();
    renderStreamers();
    renderEstatisticas();
    renderAtualizacao();
    renderCategorias();
    renderRanking();
    const novas = compararAoVivo();
    avisar(novas);
  };

  const carregarLive = async () => {
    // 1) Arquivo gerado pelo GitHub Actions: serve de base e cobre a Twitch.
    try {
      estado.live = await buscarJson(ARQUIVO_LIVE);
    } catch (erro) {
      console.warn("Não foi possível carregar data/live.json:", erro);
      estado.live = { geradoEm: null, streamers: {} };
    }

    if (!estado.live.streamers) estado.live.streamers = {};

    // 2) Kick consultada direto no navegador: status em tempo real.
    let direto = false;
    try {
      direto = (await atualizarKickAoVivo()) > 0;
    } catch (erro) {
      console.warn("Consulta direta à Kick indisponível:", erro);
    }

    estado.live.direto = direto;
    if (direto) estado.live.geradoEm = new Date().toISOString();

    atualizarInterface();
  };

  const iniciar = async () => {
    atualizarBotoesNotif();

    try {
      estado.config = await buscarJson(ARQUIVO_STREAMERS);
    } catch (erro) {
      console.error("Não foi possível carregar a lista de streamers:", erro);
      const lista = $("#listaStreamers");
      if (lista) {
        lista.setAttribute("aria-busy", "false");
        lista.innerHTML = `<p class="lead">Não foi possível carregar a lista de streamers. Recarregue a página.</p>`;
      }
      return;
    }

    // Link do Discord configurado em data/streamers.json
    const discord = estado.config?.comunidade?.discord;
    if (discord) {
      document.querySelectorAll("[data-discord]").forEach((link) => {
        link.setAttribute("href", discord);
      });
    }

    renderStreamers();
    ligarControlesMetricas();
    await carregarLive();

    window.setInterval(carregarLive, INTERVALO_ATUALIZACAO);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") carregarLive();
    });

    for (const botao of botoesNotif()) {
      botao.addEventListener("click", pedirPermissao);
    }
  };

  /* ---------- Interface geral (menu, scroll, filtros) ---------- */

  const header = document.getElementById("header");
  const sincronizarHeader = () => {
    header?.classList.toggle("is-scrolled", window.scrollY > 20);
  };
  window.addEventListener("scroll", sincronizarHeader, { passive: true });
  sincronizarHeader();

  const toggle = document.getElementById("navToggle");
  const nav = document.getElementById("nav");
  const fecharMenu = () => {
    if (!nav || !toggle) return;
    nav.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Abrir menu");
  };

  if (toggle && nav) {
    toggle.addEventListener("click", () => {
      const aberto = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(aberto));
      toggle.setAttribute("aria-label", aberto ? "Fechar menu" : "Abrir menu");
    });
    nav.querySelectorAll("a").forEach((link) => link.addEventListener("click", fecharMenu));
    document.addEventListener("keydown", (evento) => {
      if (evento.key === "Escape") fecharMenu();
    });
  }

  // Revelar elementos ao rolar
  const revelaveis = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    const observador = new IntersectionObserver(
      (entradas) => {
        entradas.forEach((entrada) => {
          if (!entrada.isIntersecting) return;
          entrada.target.classList.add("is-visible");
          observador.unobserve(entrada.target);
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -40px 0px" }
    );
    revelaveis.forEach((elemento) => observador.observe(elemento));
  } else {
    revelaveis.forEach((elemento) => elemento.classList.add("is-visible"));
  }

  // Filtros por plataforma
  const filtros = document.getElementById("filtros");
  filtros?.addEventListener("click", (evento) => {
    const botao = evento.target.closest(".chip");
    if (!botao) return;
    estado.filtro = botao.dataset.filtro || "todos";
    filtros.querySelectorAll(".chip").forEach((chip) => {
      chip.classList.toggle("is-active", chip === botao);
    });
    renderStreamers();
  });

  // Link ativo no menu
  const secoes = Array.from(document.querySelectorAll("main section[id]"));
  const linksMenu = Array.from(document.querySelectorAll(".nav > a[href^='#']"));
  if (secoes.length && linksMenu.length && "IntersectionObserver" in window) {
    const observadorSecao = new IntersectionObserver(
      (entradas) => {
        entradas.forEach((entrada) => {
          if (!entrada.isIntersecting) return;
          linksMenu.forEach((link) => {
            link.classList.toggle("is-active", link.getAttribute("href") === `#${entrada.target.id}`);
          });
        });
      },
      { rootMargin: "-45% 0px -50% 0px" }
    );
    secoes.forEach((secao) => observadorSecao.observe(secao));
  }

  // FAQ: só uma resposta aberta
  const itensFaq = Array.from(document.querySelectorAll(".faq details"));
  itensFaq.forEach((item) => {
    item.addEventListener("toggle", () => {
      if (!item.open) return;
      itensFaq.forEach((outro) => {
        if (outro !== item) outro.open = false;
      });
    });
  });

  const ano = document.getElementById("year");
  if (ano) ano.textContent = String(new Date().getFullYear());

  iniciar();
})();

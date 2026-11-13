/* EntradaSegura - frontend sin build. Usa ethers v6 y qrcode-generator (CDN). */
const cfg = window.APP_CONFIG || {};
const $ = (s) => document.querySelector(s);
const RPC = { 11155111: "https://ethereum-sepolia-rpc.publicnode.com", 31337: "http://127.0.0.1:8545" };
const D = 6; // decimales de mUSDC

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
];
const NFT_ABI = ["function ownerOf(uint256) view returns (address)", "function nextTokenId() view returns (uint256)"];
const T_ABI = [
  "function eventCount() view returns (uint32)",
  "function events(uint32) view returns (address organizer,uint64 startTime,uint32 sold,uint128 price,uint64 endTime,uint32 capacity,uint16 maxPerWallet,bool cancelled)",
  "function proceeds(uint32) view returns (uint256)",
  "function ticketData(uint256) view returns (uint32 eventId,bool used)",
  "function listings(uint256) view returns (address seller,uint128 price)",
  "function maxResalePrice(uint32) view returns (uint128)",
  "function verifyTicket(uint256) view returns (address holder,uint32 eventId,bool used,bool cancelled)",
  "function getCheckInDigest(uint256,uint256) view returns (bytes32)",
  "function ORGANIZER_ROLE() view returns (bytes32)",
  "function VALIDATOR_ROLE() view returns (bytes32)",
  "function createEvent(string,uint64,uint64,uint128,uint32,uint16) returns (uint32)",
  "function cancelEvent(uint32)",
  "function withdrawProceeds(uint32)",
  "function buyTickets(uint32,uint16) returns (uint256)",
  "function transferTicket(uint256,address)",
  "function listForResale(uint256,uint128)",
  "function cancelListing(uint256)",
  "function buyResale(uint256)",
  "function checkIn(uint256,uint256,bytes)",
  "function claimRefund(uint256)",
  "function grantRole(bytes32,address)",
  "event EventCreated(uint32 indexed eventId,address indexed organizer,string name,uint64 startTime,uint64 endTime,uint128 price,uint32 capacity,uint16 maxPerWallet)",
  "error InvalidEventParams()", "error EventNotFound(uint32)", "error EventIsCancelled(uint32)", "error EventNotCancelled(uint32)",
  "error EventClosed(uint32)", "error InvalidQuantity()", "error SoldOut(uint32,uint32)", "error WalletLimitExceeded(uint16)",
  "error NotTicketOwner(uint256)", "error Unauthorized()", "error TicketAlreadyUsed(uint256)", "error ResalePriceTooHigh(uint128,uint128)",
  "error NotListed(uint256)", "error AlreadyListed(uint256)", "error SelfPurchase()", "error CheckInWindowClosed(uint32)",
  "error PassExpired(uint256)", "error InvalidSignature(uint256)", "error NothingToWithdraw()", "error WithdrawNotAvailable(uint32)",
  "error AccessControlUnauthorizedAccount(address,bytes32)", "error ZeroAddress()",
];

const ERRORS_ES = {
  InvalidEventParams: "Revisá los datos: fechas futuras, precio, capacidad y límite mayores a cero.",
  EventNotFound: "El evento no existe.", EventIsCancelled: "El evento fue cancelado.", EventNotCancelled: "El evento no está cancelado.",
  EventClosed: "El evento ya empezó o terminó para esta operación.", InvalidQuantity: "Cantidad inválida.",
  SoldOut: "No quedan entradas suficientes.", WalletLimitExceeded: "Superaste el máximo de entradas por persona.",
  NotTicketOwner: "No sos el titular de esta entrada.", Unauthorized: "No tenés permiso para esto.",
  TicketAlreadyUsed: "Esta entrada ya fue utilizada.", ResalePriceTooHigh: "El precio supera el máximo de reventa (cara + 10%).",
  NotListed: "La entrada no está en reventa.", AlreadyListed: "La entrada ya está en reventa.", SelfPurchase: "No podés comprar tu propia entrada.",
  CheckInWindowClosed: "El ingreso todavía no abrió o el evento terminó.", PassExpired: "El pase venció. El hincha debe generar uno nuevo.",
  InvalidSignature: "La firma no corresponde al titular de la entrada.", NothingToWithdraw: "No hay fondos para retirar.",
  WithdrawNotAvailable: "Todavía no se puede retirar (el evento no terminó).", AccessControlUnauthorizedAccount: "Tu cuenta no tiene el rol necesario.",
};

let roProvider, provider, signer, account;
let tRead, tWrite, uRead, uWrite, nftRead;
const names = new Map();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v) => Number(ethers.formatUnits(v, D)).toLocaleString("es-AR", { maximumFractionDigits: 2 });
const when = (s) => new Date(Number(s) * 1000).toLocaleString("es-AR", { dateStyle: "medium", timeStyle: "short" });
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4500);
}
function errMsg(e) {
  const name = e?.revert?.name || (e?.data && T_IFACE.parseError(e.data)?.name);
  if (name && ERRORS_ES[name]) return ERRORS_ES[name];
  if (e?.code === "ACTION_REJECTED" || e?.code === 4001) return "Cancelaste la operación en la billetera.";
  return e?.shortMessage || e?.message || "Error inesperado";
}
const T_IFACE = new ethers.Interface(T_ABI);

async function run(label, fn) {
  try {
    toast("Confirmá en tu billetera…");
    const tx = await fn();
    if (tx?.wait) { toast("Transacción enviada, esperando confirmación…"); await tx.wait(); }
    toast(`${label}: listo`);
    await refresh();
  } catch (e) { toast(errMsg(e)); console.error(e); }
}
async function ensureAllowance(amount) {
  if ((await uRead.allowance(account, cfg.EventTicketing)) < amount) {
    toast("Primero aprobá el uso de mUSDC…");
    await (await uWrite.approve(cfg.EventTicketing, amount)).wait();
  }
}

/* ---------- Inicio y conexion ---------- */
function init() {
  if (!cfg.EventTicketing) { toast("Falta frontend/config.js. Ejecutá scripts/deploy.js primero."); return; }
  roProvider = new ethers.JsonRpcProvider(RPC[cfg.chainId] || RPC[11155111], cfg.chainId, { staticNetwork: true });
  tRead = new ethers.Contract(cfg.EventTicketing, T_ABI, roProvider);
  uRead = new ethers.Contract(cfg.MockUSDC, ERC20_ABI, roProvider);
  nftRead = new ethers.Contract(cfg.TicketNFT, NFT_ABI, roProvider);
  refresh();
}
async function connect() {
  if (!window.ethereum) return toast("Instalá MetaMask u otra billetera compatible.");
  try {
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    const hex = "0x" + cfg.chainId.toString(16);
    if ((await provider.getNetwork()).chainId !== BigInt(cfg.chainId)) {
      await provider.send("wallet_switchEthereumChain", [{ chainId: hex }]);
      provider = new ethers.BrowserProvider(window.ethereum);
    }
    signer = await provider.getSigner();
    account = await signer.getAddress();
    tWrite = tRead.connect(signer);
    uWrite = uRead.connect(signer);
    $("#connect").textContent = short(account);
    $("#net").hidden = false; $("#net").textContent = cfg.network;
    $("#faucet").hidden = false;
    refresh();
  } catch (e) { toast(errMsg(e)); }
}

/* ---------- Lecturas ---------- */
async function loadNames() {
  try {
    const logs = await tRead.queryFilter(tRead.filters.EventCreated(), cfg.deployBlock || 0);
    for (const l of logs) names.set(Number(l.args.eventId), l.args.name);
  } catch (e) { console.warn("No se pudieron leer nombres", e); }
}
const evName = (id) => esc(names.get(Number(id)) || `Evento #${id}`);

async function refresh() {
  if (!tRead) return;
  await loadNames();
  const count = Number(await tRead.eventCount());
  const evs = await Promise.all(Array.from({ length: count }, (_, i) => tRead.events(i + 1)));
  renderEvents(evs);
  if (account) {
    $("#bal").textContent = `Saldo: ${fmt(await uRead.balanceOf(account))} mUSDC`;
    renderMyEvents(evs);
  }
  await renderTickets(evs);
}

function renderEvents(evs) {
  const now = Math.floor(Date.now() / 1000);
  $("#events").innerHTML = evs.length ? evs.map((e, i) => {
    const id = i + 1, left = Number(e.capacity) - Number(e.sold);
    const open = !e.cancelled && now < Number(e.startTime) && left > 0;
    const state = e.cancelled ? '<span class="tag bad">Cancelado</span>' : left === 0 ? '<span class="tag warn">Agotado</span>' : now >= Number(e.startTime) ? '<span class="tag">Ventas cerradas</span>' : '<span class="tag ok">A la venta</span>';
    return `<article class="card"><h3>${evName(id)}</h3>${state}
      <p class="muted">${when(e.startTime)} · ${fmt(e.price)} mUSDC · máx. ${e.maxPerWallet} por persona</p>
      <div class="meter" title="${e.sold} de ${e.capacity} vendidas"><span style="width:${(Number(e.sold) / Number(e.capacity)) * 100}%"></span></div>
      <div class="row"><input type="number" min="1" max="${e.maxPerWallet}" value="1" id="q${id}" aria-label="Cantidad" style="max-width:5rem">
      <button class="btn primary" data-act="buy" data-id="${id}" ${open ? "" : "disabled"}>Comprar</button></div></article>`;
  }).join("") : '<p class="muted">Todavía no hay eventos creados.</p>';
  window._evs = evs;
}

async function renderTickets(evs) {
  const next = Number(await nftRead.nextTokenId());
  const ids = Array.from({ length: Math.min(next - 1, 300) }, (_, i) => next - 1 - i);
  const rows = await Promise.all(ids.map(async (id) => {
    try {
      const [owner, td, l] = await Promise.all([nftRead.ownerOf(id), tRead.ticketData(id), tRead.listings(id)]);
      return { id, owner, eventId: Number(td.eventId), used: td.used, seller: l.seller, price: l.price };
    } catch { return null; } // quemada / reembolsada
  }));
  const live = rows.filter(Boolean);
  const mine = live.filter((t) => account && (t.owner === account || t.seller === account));
  $("#tickets").innerHTML = mine.length ? mine.map((t) => ticketHtml(t, evs, true)).join("")
    : `<p class="muted">${account ? "Todavía no tenés entradas." : "Conectá tu billetera para ver tus entradas."}</p>`;
  const market = live.filter((t) => t.seller !== ethers.ZeroAddress);
  $("#market").innerHTML = market.length ? market.map((t) => ticketHtml(t, evs, false)).join("") : '<p class="muted">No hay entradas en reventa.</p>';
}

function ticketHtml(t, evs, mine) {
  const ev = evs[t.eventId - 1];
  const listed = t.seller !== ethers.ZeroAddress;
  const status = t.used ? '<span class="tag bad">Usada</span>' : ev.cancelled ? '<span class="tag bad">Evento cancelado</span>' : listed ? `<span class="tag warn">En reventa · ${fmt(t.price)} mUSDC</span>` : '<span class="tag ok">Válida</span>';
  let actions = "";
  if (mine && ev.cancelled && !listed) actions = `<button class="btn small" data-act="refund" data-id="${t.id}">Reclamar reembolso</button>`;
  else if (mine && listed) actions = `<button class="btn small" data-act="unlist" data-id="${t.id}">Quitar de reventa</button>`;
  else if (mine && !t.used) actions = `<button class="btn small primary" data-act="pass" data-id="${t.id}">Mostrar pase</button>
      <button class="btn small" data-act="gift" data-id="${t.id}">Regalar</button>
      <button class="btn small" data-act="list" data-id="${t.id}" data-ev="${t.eventId}">Revender</button>`;
  else if (!mine && account && t.seller !== account) actions = `<button class="btn small primary" data-act="buyresale" data-id="${t.id}" data-price="${t.price}">Comprar ${fmt(t.price)} mUSDC</button>`;
  return `<div class="ticket"><div class="body"><h3>${evName(t.eventId)}</h3><p class="muted" style="margin:0">${when(ev.startTime)}</p>
    <p style="margin:.4rem 0 0">${status}</p><div class="actions">${actions}</div></div>
    <div class="stub"><span class="muted" style="margin:0">Entrada</span><span class="tid">#${t.id}</span></div></div>`;
}

function renderMyEvents(evs) {
  const mine = evs.map((e, i) => ({ e, id: i + 1 })).filter((x) => x.e.organizer === account);
  $("#myEvents").innerHTML = mine.length ? mine.map(({ e, id }) => `<article class="card"><h3>${evName(id)}</h3>
    <p class="muted">${e.sold}/${e.capacity} vendidas · ${e.cancelled ? "cancelado" : "activo"}</p>
    <div class="actions"><button class="btn small" data-act="withdraw" data-id="${id}">Retirar fondos</button>
    <button class="btn small" data-act="cancel" data-id="${id}" ${e.cancelled ? "disabled" : ""}>Cancelar evento</button></div></article>`).join("")
    : '<p class="muted">No creaste eventos con esta cuenta.</p>';
}

/* ---------- Verificacion publica (no requiere billetera) ---------- */
$("#verifyForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const out = $("#verifyOut"); out.hidden = false;
  const id = $("#vId").value.trim();
  if (!tRead) { out.className = "verdict warn"; out.textContent = "La app todavía no está configurada."; return; }
  try {
    const r = await tRead.verifyTicket(id);
    const name = names.get(Number(r.eventId)) || `Evento #${r.eventId}`;
    const inResale = r.holder.toLowerCase() === cfg.EventTicketing.toLowerCase();
    if (r.used) { out.className = "verdict warn"; out.innerHTML = `Entrada #${esc(id)} auténtica, pero ya fue utilizada.<small>${esc(name)}</small>`; }
    else if (r.cancelled) { out.className = "verdict warn"; out.innerHTML = `Entrada #${esc(id)} auténtica, pero el evento fue cancelado.<small>${esc(name)}</small>`; }
    else { out.className = "verdict ok"; out.innerHTML = `Entrada #${esc(id)} auténtica y válida.<small>${esc(name)} · ${inResale ? "en reventa oficial" : "titular " + r.holder}</small>`; }
  } catch {
    out.className = "verdict bad"; out.textContent = `La entrada #${id} no existe en la blockchain. No la compres: es falsa o ya fue reembolsada.`;
  }
});

/* ---------- Acciones ---------- */
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  if (!signer) return toast("Conectá tu billetera primero.");
  const id = b.dataset.id, act = b.dataset.act;
  if (act === "buy") {
    const qty = Number($(`#q${id}`).value || 1), ev = window._evs[id - 1];
    return run("Compra", async () => { await ensureAllowance(ev.price * BigInt(qty)); return tWrite.buyTickets(id, qty); });
  }
  if (act === "pass") return showPass(id);
  if (act === "gift") { const to = prompt("Dirección que recibirá la entrada (0x…):"); if (to) run("Regalo", () => tWrite.transferTicket(id, to.trim())); return; }
  if (act === "list") {
    const max = await tRead.maxResalePrice(b.dataset.ev);
    const p = prompt(`Precio de reventa en mUSDC (máximo ${fmt(max)}):`); if (!p) return;
    return run("Publicación", () => tWrite.listForResale(id, ethers.parseUnits(p.replace(",", "."), D)));
  }
  if (act === "unlist") return run("Publicación cancelada", () => tWrite.cancelListing(id));
  if (act === "buyresale") return run("Compra en reventa", async () => { await ensureAllowance(BigInt(b.dataset.price)); return tWrite.buyResale(id); });
  if (act === "refund") return run("Reembolso", () => tWrite.claimRefund(id));
  if (act === "cancel") return confirm("¿Cancelar el evento? Los compradores podrán reclamar su reembolso.") && run("Evento cancelado", () => tWrite.cancelEvent(id));
  if (act === "withdraw") return run("Retiro", () => tWrite.withdrawProceeds(id));
});
$("#connect").addEventListener("click", connect);
$("#faucet").addEventListener("click", () => run("Faucet", () => uWrite.mint(account, ethers.parseUnits("1000", D))));
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + t.dataset.tab));
}));

/* ---------- Pase de ingreso (QR firmado, vence a los 5 minutos) ---------- */
async function showPass(id) {
  try {
    const block = await roProvider.getBlock("latest");
    const deadline = block.timestamp + 300;
    toast("Firmá el pase en tu billetera (no cuesta gas)…");
    const sig = await signer.signMessage(ethers.getBytes(await tRead.getCheckInDigest(id, deadline)));
    const payload = JSON.stringify({ t: Number(id), d: deadline, s: sig });
    const qr = qrcode(0, "M"); qr.addData(payload); qr.make();
    $("#qr").innerHTML = qr.createImgTag(5, 8);
    $("#passTitle").textContent = `Pase de la entrada #${id}`;
    $("#passExp").textContent = `Válido hasta las ${new Date(deadline * 1000).toLocaleTimeString("es-AR")}. Una captura de pantalla vieja no sirve.`;
    $("#passText").value = payload;
    $("#passDlg").showModal();
  } catch (e) { toast(errMsg(e)); }
}
$("#closePass").addEventListener("click", () => $("#passDlg").close());
$("#copyPass").addEventListener("click", async () => { await navigator.clipboard.writeText($("#passText").value); toast("Pase copiado"); });

/* ---------- Organizador / admin ---------- */
$("#createForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!signer) return toast("Conectá tu billetera primero.");
  const f = new FormData(e.target);
  const ts = (v) => Math.floor(new Date(v).getTime() / 1000);
  run("Evento creado", () => tWrite.createEvent(f.get("name"), ts(f.get("start")), ts(f.get("end")), ethers.parseUnits(String(f.get("price")), D), f.get("capacity"), f.get("maxPer")));
});
$("#roleForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!signer) return toast("Conectá tu billetera primero.");
  const f = new FormData(e.target);
  run("Rol otorgado", async () => tWrite.grantRole(await tRead[f.get("role")](), f.get("addr").trim()));
});

/* ---------- Control de acceso ---------- */
$("#gateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = $("#gateOut"); out.hidden = false;
  if (!signer) { out.className = "verdict warn"; out.textContent = "Conectá la billetera del validador."; return; }
  try {
    const p = JSON.parse(new FormData(e.target).get("pass"));
    await tWrite.checkIn.staticCall(p.t, p.d, p.s); // simula primero para dar un motivo claro
    const tx = await tWrite.checkIn(p.t, p.d, p.s);
    out.className = "verdict warn"; out.textContent = "Registrando ingreso…";
    await tx.wait();
    out.className = "verdict ok"; out.innerHTML = `Entrada #${esc(p.t)} válida. Puede pasar.<small>${esc(tx.hash)}</small>`;
  } catch (err) {
    out.className = "verdict bad"; out.textContent = "No puede ingresar: " + errMsg(err);
  }
});

init();

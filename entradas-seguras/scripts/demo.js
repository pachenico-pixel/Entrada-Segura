// Demo del flujo principal on-chain: crear evento -> comprar -> transferir/revender -> check-in -> anti-reuso.
// Requiere haber corrido scripts/deploy.js en la misma red.
// Uso: npx hardhat run scripts/demo.js --network sepolia
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const PRICE = 50_000_000n; // 50 mUSDC

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Falta ${file}. Ejecuta primero scripts/deploy.js`);
  const d = JSON.parse(fs.readFileSync(file));

  const [me] = await ethers.getSigners();
  const usdc = await ethers.getContractAt("MockUSDC", d.MockUSDC);
  const ticketing = await ethers.getContractAt("EventTicketing", d.EventTicketing);
  const hashes = {};
  const step = async (label, txPromise) => {
    const tx = await txPromise;
    const r = await tx.wait();
    hashes[label] = r.hash;
    console.log(`✔ ${label}: ${r.hash}`);
    return r;
  };

  const block = await ethers.provider.getBlock("latest");
  const start = block.timestamp + 3600; // arranca en 1 h (el check-in abre 4 h antes)
  const end = start + 3 * 3600;

  const r1 = await step("1. createEvent", ticketing.createEvent("Despedida de Messi - Monumental", start, end, PRICE, 100, 4));
  const eventId = await ticketing.eventCount();
  console.log(`   eventId = ${eventId}`);

  await step("2. mint mUSDC (faucet)", usdc.mint(me.address, 500_000_000n));
  await step("3. approve mUSDC", usdc.approve(d.EventTicketing, ethers.MaxUint256));
  const r4 = await step("4. buyTickets x2", ticketing.buyTickets(eventId, 2));
  const log = r4.logs.map((l) => { try { return ticketing.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "TicketsPurchased");
  const tokenId = log.args.firstTokenId;
  console.log(`   entradas emitidas: #${tokenId} y #${tokenId + 1n}`);

  const price = (await ticketing.maxResalePrice(eventId));
  await step("5. listForResale (tope +10%)", ticketing.listForResale(tokenId + 1n, price));
  await step("6. cancelListing", ticketing.cancelListing(tokenId + 1n));

  // Pase de ingreso: el titular firma off-chain; el validador lo registra on-chain.
  const deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
  const sig = await me.signMessage(ethers.getBytes(await ticketing.getCheckInDigest(tokenId, deadline)));
  await step("7. checkIn", ticketing.checkIn(tokenId, deadline, sig));

  try {
    await ticketing.checkIn.staticCall(tokenId, deadline, sig);
  } catch (e) {
    console.log(`✔ Reuso bloqueado: ${ticketing.interface.parseError(e.data)?.name ?? e.shortMessage}`);
  }
  const v = await ticketing.verifyTicket(tokenId);
  console.log(`Estado final entrada #${tokenId}: titular=${v.holder} usada=${v.used}`);
  console.log("\nHashes para el README:\n", JSON.stringify(hashes, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

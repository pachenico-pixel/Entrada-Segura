// Despliega MockUSDC + EventTicketing (que despliega TicketNFT), otorga roles y guarda las direcciones.
// Uso: npx hardhat run scripts/deploy.js --network sepolia
const fs = require("fs");
const path = require("path");
const { ethers, network, run } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Red: ${network.name} | Deployer: ${deployer.address}`);

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  await usdc.waitForDeployment();

  const ticketing = await (await ethers.getContractFactory("EventTicketing")).deploy(usdc.target, deployer.address);
  await ticketing.waitForDeployment();
  const nftAddress = await ticketing.ticketNFT();

  // Para la demo, el deployer actua tambien como organizador y validador.
  await (await ticketing.grantRole(await ticketing.ORGANIZER_ROLE(), deployer.address)).wait();
  await (await ticketing.grantRole(await ticketing.VALIDATOR_ROLE(), deployer.address)).wait();

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    MockUSDC: usdc.target,
    EventTicketing: ticketing.target,
    TicketNFT: nftAddress,
    deployBlock: (await ticketing.deploymentTransaction().wait()).blockNumber,
  };
  console.table(out);

  fs.mkdirSync(path.join(__dirname, "..", "deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), JSON.stringify(out, null, 2));
  // El frontend lee esta configuracion.
  fs.writeFileSync(
    path.join(__dirname, "..", "frontend", "config.js"),
    `window.APP_CONFIG = ${JSON.stringify(out, null, 2)};\n`
  );

  if (!["hardhat", "localhost"].includes(network.name)) {
    console.log("Esperando confirmaciones para verificar en el explorer...");
    await ticketing.deploymentTransaction().wait(5);
    const attempts = [
      ["MockUSDC", usdc.target, []],
      ["EventTicketing", ticketing.target, [usdc.target, deployer.address]],
      ["TicketNFT", nftAddress, ["EntradaSegura Ticket", "ESTK", ticketing.target]],
    ];
    for (const [name, address, constructorArguments] of attempts) {
      try {
        await run("verify:verify", { address, constructorArguments });
        console.log(`Verificado: ${name}`);
      } catch (e) {
        console.log(`Verificacion de ${name}: ${e.message.split("\n")[0]}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

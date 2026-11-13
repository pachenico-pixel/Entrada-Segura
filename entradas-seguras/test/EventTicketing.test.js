const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const PRICE = 50_000_000n; // 50 mUSDC (6 decimales)
const DAY = 24 * 60 * 60;

describe("EntradaSegura - EventTicketing", function () {
  async function deployFixture() {
    const [admin, organizer, validator, alice, bob, carol] = await ethers.getSigners();

    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const ticketing = await (await ethers.getContractFactory("EventTicketing")).deploy(usdc.target, admin.address);
    const nft = await ethers.getContractAt("TicketNFT", await ticketing.ticketNFT());

    await ticketing.grantRole(await ticketing.ORGANIZER_ROLE(), organizer.address);
    await ticketing.grantRole(await ticketing.VALIDATOR_ROLE(), validator.address);

    for (const u of [alice, bob, carol]) {
      await usdc.mint(u.address, 1_000_000_000n);
      await usdc.connect(u).approve(ticketing.target, ethers.MaxUint256);
    }

    const now = await time.latest();
    const start = now + 7 * DAY;
    const end = start + 4 * 3600;
    await ticketing.connect(organizer).createEvent("Despedida en el Monumental", start, end, PRICE, 5, 3);

    return { admin, organizer, validator, alice, bob, carol, usdc, ticketing, nft, start, end };
  }

  async function signPass(ticketing, signer, tokenId, deadline) {
    const digest = await ticketing.getCheckInDigest(tokenId, deadline);
    return signer.signMessage(ethers.getBytes(digest));
  }

  describe("Creacion de eventos", function () {
    it("crea un evento y emite EventCreated", async function () {
      const { ticketing, organizer } = await loadFixture(deployFixture);
      const now = await time.latest();
      await expect(ticketing.connect(organizer).createEvent("Otro", now + 100, now + 200, 1n, 10, 2))
        .to.emit(ticketing, "EventCreated");
      expect(await ticketing.eventCount()).to.equal(2);
    });

    it("revierte si no es organizador", async function () {
      const { ticketing, alice } = await loadFixture(deployFixture);
      const now = await time.latest();
      await expect(ticketing.connect(alice).createEvent("X", now + 100, now + 200, 1n, 10, 2))
        .to.be.revertedWithCustomError(ticketing, "AccessControlUnauthorizedAccount");
    });

    it("revierte con parametros invalidos", async function () {
      const { ticketing, organizer } = await loadFixture(deployFixture);
      const now = await time.latest();
      const c = ticketing.connect(organizer);
      await expect(c.createEvent("X", now - 1, now + 200, 1n, 10, 2)).to.be.revertedWithCustomError(ticketing, "InvalidEventParams");
      await expect(c.createEvent("X", now + 100, now + 100, 1n, 10, 2)).to.be.revertedWithCustomError(ticketing, "InvalidEventParams");
      await expect(c.createEvent("X", now + 100, now + 200, 0n, 10, 2)).to.be.revertedWithCustomError(ticketing, "InvalidEventParams");
      await expect(c.createEvent("X", now + 100, now + 200, 1n, 0, 2)).to.be.revertedWithCustomError(ticketing, "InvalidEventParams");
      await expect(c.createEvent("X", now + 100, now + 200, 1n, 10, 0)).to.be.revertedWithCustomError(ticketing, "InvalidEventParams");
    });

    it("no permite direccion cero en el constructor", async function () {
      const f = await ethers.getContractFactory("EventTicketing");
      await expect(f.deploy(ethers.ZeroAddress, ethers.ZeroAddress)).to.be.revertedWithCustomError(f, "ZeroAddress");
    });
  });

  describe("Venta primaria (flujo principal)", function () {
    it("compra entradas: cobra, emite NFTs y acumula fondos", async function () {
      const { ticketing, usdc, nft, alice } = await loadFixture(deployFixture);
      await expect(ticketing.connect(alice).buyTickets(1, 2))
        .to.emit(ticketing, "TicketsPurchased")
        .withArgs(1, alice.address, 1, 2, PRICE * 2n);

      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect(await nft.ownerOf(2)).to.equal(alice.address);
      expect(await usdc.balanceOf(ticketing.target)).to.equal(PRICE * 2n);
      expect(await ticketing.proceeds(1)).to.equal(PRICE * 2n);
      expect((await ticketing.events(1)).sold).to.equal(2);
      expect(await nft.tokenURI(1)).to.contain("/ticket/1");
    });

    it("respeta el limite por billetera", async function () {
      const { ticketing, alice } = await loadFixture(deployFixture);
      await ticketing.connect(alice).buyTickets(1, 3);
      await expect(ticketing.connect(alice).buyTickets(1, 1))
        .to.be.revertedWithCustomError(ticketing, "WalletLimitExceeded").withArgs(3);
    });

    it("revierte al agotarse la capacidad", async function () {
      const { ticketing, alice, bob, carol } = await loadFixture(deployFixture);
      await ticketing.connect(alice).buyTickets(1, 3);
      await ticketing.connect(bob).buyTickets(1, 2);
      await expect(ticketing.connect(carol).buyTickets(1, 1))
        .to.be.revertedWithCustomError(ticketing, "SoldOut").withArgs(1, 0);
    });

    it("revierte con cantidad cero, evento inexistente o ventas cerradas", async function () {
      const { ticketing, alice, start } = await loadFixture(deployFixture);
      await expect(ticketing.connect(alice).buyTickets(1, 0)).to.be.revertedWithCustomError(ticketing, "InvalidQuantity");
      await expect(ticketing.connect(alice).buyTickets(99, 1)).to.be.revertedWithCustomError(ticketing, "EventNotFound");
      await time.increaseTo(start);
      await expect(ticketing.connect(alice).buyTickets(1, 1)).to.be.revertedWithCustomError(ticketing, "EventClosed");
    });

    it("revierte si el comprador no aprobo fondos", async function () {
      const { ticketing, usdc, alice } = await loadFixture(deployFixture);
      await usdc.connect(alice).approve(ticketing.target, 0);
      await expect(ticketing.connect(alice).buyTickets(1, 1)).to.be.reverted;
    });
  });

  describe("Anti-falsificacion y restriccion de transferencias", function () {
    it("una entrada inexistente (trucha) no se puede verificar", async function () {
      const { ticketing } = await loadFixture(deployFixture);
      await expect(ticketing.verifyTicket(12345)).to.be.reverted;
    });

    it("verifyTicket devuelve titular, evento y estado", async function () {
      const { ticketing, alice } = await loadFixture(deployFixture);
      await ticketing.connect(alice).buyTickets(1, 1);
      const r = await ticketing.verifyTicket(1);
      expect(r.holder).to.equal(alice.address);
      expect(r.eventId).to.equal(1);
      expect(r.used).to.equal(false);
      expect(r.cancelled).to.equal(false);
    });

    it("el titular no puede transferir por ERC-721 estandar", async function () {
      const { ticketing, nft, alice, bob } = await loadFixture(deployFixture);
      await ticketing.connect(alice).buyTickets(1, 1);
      await expect(nft.connect(alice).transferFrom(alice.address, bob.address, 1))
        .to.be.revertedWithCustomError(nft, "TransferRestricted");
      await expect(nft.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 1))
        .to.be.revertedWithCustomError(nft, "TransferRestricted");
    });

    it("nadie fuera de EventTicketing puede mintear, quemar ni transferir", async function () {
      const { ticketing, nft, alice } = await loadFixture(deployFixture);
      await ticketing.connect(alice).buyTickets(1, 1);
      await expect(nft.connect(alice).mintBatch(alice.address, 1)).to.be.revertedWithCustomError(nft, "NotTicketing");
      await expect(nft.connect(alice).burn(1)).to.be.revertedWithCustomError(nft, "NotTicketing");
      await expect(nft.connect(alice).ticketTransfer(alice.address, alice.address, 1)).to.be.revertedWithCustomError(nft, "NotTicketing");
    });

    it("TicketNFT rechaza direccion cero como ticketing", async function () {
      const f = await ethers.getContractFactory("TicketNFT");
      await expect(f.deploy("A", "B", ethers.ZeroAddress)).to.be.revertedWithCustomError(f, "ZeroAddress");
    });

    it("transferTicket regala una entrada y valida precondiciones", async function () {
      const { ticketing, nft, alice, bob } = await loadFixture(deployFixture);
      await ticketing.connect(alice).buyTickets(1, 1);
      await expect(ticketing.connect(bob).transferTicket(1, alice.address)).to.be.revertedWithCustomError(ticketing, "NotTicketOwner");
      await expect(ticketing.connect(alice).transferTicket(1, ethers.ZeroAddress)).to.be.revertedWithCustomError(ticketing, "ZeroAddress");
      await expect(ticketing.connect(alice).transferTicket(1, bob.address)).to.emit(ticketing, "TicketTransferred");
      expect(await nft.ownerOf(1)).to.equal(bob.address);
    });
  });

  describe("Reventa con tope de precio", function () {
    it("lista, compra en reventa y reparte comision al organizador", async function () {
      const { ticketing, usdc, nft, alice, bob } = await loadFixture(deployFixture);
      await ticketing.connect(alice).buyTickets(1, 1);
      const price = PRICE + PRICE / 10n; // tope: +10%

      await expect(ticketing.connect(alice).listForResale(1, price)).to.emit(ticketing, "TicketListed");
      expect(await nft.ownerOf(1)).to.equal(ticketing.target);

      const aliceBefore = await usdc.balanceOf(alice.address);
      const fee = (price * 500n) / 10_000n;
      await expect(ticketing.connect(bob).buyResale(1)).to.emit(ticketing, "TicketResold").withArgs(1, alice.address, bob.address, price, fee);

      expect(await nft.ownerOf(1)).to.equal(bob.address);
      expect((await usdc.balanceOf(alice.address)) - aliceBefore).to.equal(price - fee);
      expect(await ticketing.proceeds(1)).to.equal(PRICE + fee);
    });

    it("rechaza precios por encima del tope o en cero", async function () {
      const { ticketing, alice } = await loadFixture(deployFixture);
      await ticketing.connect(alice).buyTickets(1, 1);
      const max = await ticketing.maxResalePrice(1);
      await expect(ticketing.connect(alice).listForResale(1, max + 1n)).to.be.revertedWithCustomError(ticketing, "ResalePriceTooHigh");
      await expect(ticketing.connect(alice).listForResale(1, 0)).to.be.revertedWithCustomError(ticketing, "ResalePriceTooHigh");
    });

    it("solo el titular puede listar y no se puede listar dos veces", async function () {
      const { ticketing, alice, bob } = await loadFixture(deployFixture);
      await ticketing.connect(alice).buyTickets(1, 1);
      await expect(ticketing.connect(bob).listForResale(1, PRICE)).to.be.revertedWithCustomError(ticketing, "NotTicketOwner");
      await ticketing.connect(alice).listForResale(1, PRICE);
      await expect(ticketing.connect(alice).listForResale(1, PRICE)).to.be.revertedWithCustomError(ticketing, "AlreadyListed");
    });

    it("cancelListing devuelve la entrada y valida permisos", async function () {
      const { ticketing, nft, alice, bob } = await loadFixture(deployFixture);
      await ticketing.connect(alice).buyTickets(1, 1);
      await expect(ticketing.connect(alice).cancelListing(1)).to.be.revertedWithCustomError(ticketing, "NotListed");
      await ticketing.connect(alice).listForResale(1, PRICE);
      await expect(ticketing.connect(bob).cancelListing(1)).to.be.revertedWithCustomError(ticketing, "Unauthorized");
      await expect(ticketing.connect(alice).cancelListing(1)).to.emit(ticketing, "ListingCancelled");
      expect(await nft.ownerOf(1)).to.equal(alice.address);
    });

    it("no permite comprar la propia publicacion ni una inexistente", async function () {
      const { ticketing, alice } = await loadFixture(deployFixture);
      await ticketing.connect(alice).buyTickets(1, 1);
      await ticketing.connect(alice).listForResale(1, PRICE);
      await expect(ticketing.connect(alice).buyResale(1)).to.be.revertedWithCustomError(ticketing, "SelfPurchase");
      await expect(ticketing.connect(alice).buyResale(2)).to.be.revertedWithCustomError(ticketing, "NotListed");
    });
  });

  describe("Check-in con QR rotativo", function () {
    async function atGate() {
      const ctx = await deployFixture();
      await ctx.ticketing.connect(ctx.alice).buyTickets(1, 1);
      await time.increaseTo(ctx.start + 60);
      return ctx;
    }

    it("valida una entrada con firma del titular y la marca como usada", async function () {
      const { ticketing, validator, alice } = await loadFixture(atGate);
      const deadline = (await time.latest()) + 60;
      const sig = await signPass(ticketing, alice, 1, deadline);
      await expect(ticketing.connect(validator).checkIn(1, deadline, sig)).to.emit(ticketing, "TicketCheckedIn").withArgs(1, 1, alice.address, validator.address);
      expect((await ticketing.verifyTicket(1)).used).to.equal(true);
    });

    it("impide reutilizar la entrada (QR clonado)", async function () {
      const { ticketing, validator, alice } = await loadFixture(atGate);
      const deadline = (await time.latest()) + 120;
      const sig = await signPass(ticketing, alice, 1, deadline);
      await ticketing.connect(validator).checkIn(1, deadline, sig);
      await expect(ticketing.connect(validator).checkIn(1, deadline, sig)).to.be.revertedWithCustomError(ticketing, "TicketAlreadyUsed");
    });

    it("rechaza firmas de quien no es el titular", async function () {
      const { ticketing, validator, bob } = await loadFixture(atGate);
      const deadline = (await time.latest()) + 60;
      const sig = await signPass(ticketing, bob, 1, deadline);
      await expect(ticketing.connect(validator).checkIn(1, deadline, sig)).to.be.revertedWithCustomError(ticketing, "InvalidSignature");
    });

    it("rechaza pases vencidos (captura de pantalla vieja)", async function () {
      const { ticketing, validator, alice } = await loadFixture(atGate);
      const deadline = (await time.latest()) + 30;
      const sig = await signPass(ticketing, alice, 1, deadline);
      await time.increase(60);
      await expect(ticketing.connect(validator).checkIn(1, deadline, sig)).to.be.revertedWithCustomError(ticketing, "PassExpired");
    });

    it("solo validadores pueden ejecutar check-in", async function () {
      const { ticketing, alice } = await loadFixture(atGate);
      const deadline = (await time.latest()) + 60;
      const sig = await signPass(ticketing, alice, 1, deadline);
      await expect(ticketing.connect(alice).checkIn(1, deadline, sig)).to.be.revertedWithCustomError(ticketing, "AccessControlUnauthorizedAccount");
    });

    it("respeta la ventana de check-in", async function () {
      const { ticketing, validator, alice, end } = await loadFixture(deployFixture);
      await ticketing.connect(alice).buyTickets(1, 1);
      let deadline = (await time.latest()) + 60;
      let sig = await signPass(ticketing, alice, 1, deadline);
      await expect(ticketing.connect(validator).checkIn(1, deadline, sig)).to.be.revertedWithCustomError(ticketing, "CheckInWindowClosed");
      await time.increaseTo(end + 1);
      deadline = (await time.latest()) + 60;
      sig = await signPass(ticketing, alice, 1, deadline);
      await expect(ticketing.connect(validator).checkIn(1, deadline, sig)).to.be.revertedWithCustomError(ticketing, "CheckInWindowClosed");
    });

    it("el comprador de reventa pasa a ser el unico titular valido", async function () {
      const ctx = await deployFixture();
      const { ticketing, validator, alice, bob } = ctx;
      await ticketing.connect(alice).buyTickets(1, 1);
      await ticketing.connect(alice).listForResale(1, PRICE);
      await ticketing.connect(bob).buyResale(1);
      await time.increaseTo(ctx.start + 60);
      const deadline = (await time.latest()) + 60;
      const oldSig = await signPass(ticketing, alice, 1, deadline);
      await expect(ticketing.connect(validator).checkIn(1, deadline, oldSig)).to.be.revertedWithCustomError(ticketing, "InvalidSignature");
      const newSig = await signPass(ticketing, bob, 1, deadline);
      await expect(ticketing.connect(validator).checkIn(1, deadline, newSig)).to.emit(ticketing, "TicketCheckedIn");
    });

    it("una entrada usada ya no se puede transferir ni revender", async function () {
      const { ticketing, validator, alice, bob } = await loadFixture(atGate);
      const deadline = (await time.latest()) + 60;
      await ticketing.connect(validator).checkIn(1, deadline, await signPass(ticketing, alice, 1, deadline));
      await expect(ticketing.connect(alice).transferTicket(1, bob.address)).to.be.revertedWithCustomError(ticketing, "TicketAlreadyUsed");
      await expect(ticketing.connect(alice).listForResale(1, PRICE)).to.be.revertedWithCustomError(ticketing, "TicketAlreadyUsed");
    });
  });

  describe("Cancelacion, reembolsos y retiro de fondos", function () {
    it("cancelar: solo organizador o admin, una vez", async function () {
      const { ticketing, organizer, admin, alice } = await loadFixture(deployFixture);
      await expect(ticketing.connect(alice).cancelEvent(1)).to.be.revertedWithCustomError(ticketing, "Unauthorized");
      await expect(ticketing.connect(organizer).cancelEvent(1)).to.emit(ticketing, "EventCancelled");
      await expect(ticketing.connect(admin).cancelEvent(1)).to.be.revertedWithCustomError(ticketing, "EventIsCancelled");
      await expect(ticketing.connect(alice).buyTickets(1, 1)).to.be.revertedWithCustomError(ticketing, "EventIsCancelled");
    });

    it("no se puede cancelar un evento finalizado", async function () {
      const { ticketing, organizer, end } = await loadFixture(deployFixture);
      await time.increaseTo(end);
      await expect(ticketing.connect(organizer).cancelEvent(1)).to.be.revertedWithCustomError(ticketing, "EventClosed");
    });

    it("reembolsa a los titulares y quema las entradas", async function () {
      const { ticketing, usdc, nft, organizer, alice } = await loadFixture(deployFixture);
      await ticketing.connect(alice).buyTickets(1, 2);
      await expect(ticketing.connect(alice).claimRefund(1)).to.be.revertedWithCustomError(ticketing, "EventNotCancelled");
      await ticketing.connect(organizer).cancelEvent(1);

      const before = await usdc.balanceOf(alice.address);
      await expect(ticketing.connect(alice).claimRefund(1)).to.emit(ticketing, "TicketRefunded").withArgs(1, alice.address, PRICE);
      expect((await usdc.balanceOf(alice.address)) - before).to.equal(PRICE);
      await expect(nft.ownerOf(1)).to.be.reverted;
      await expect(ticketing.connect(alice).claimRefund(1)).to.be.reverted; // ya reembolsada
      expect(await ticketing.proceeds(1)).to.equal(PRICE);
    });

    it("solo el titular reclama el reembolso", async function () {
      const { ticketing, organizer, alice, bob } = await loadFixture(deployFixture);
      await ticketing.connect(alice).buyTickets(1, 1);
      await ticketing.connect(organizer).cancelEvent(1);
      await expect(ticketing.connect(bob).claimRefund(1)).to.be.revertedWithCustomError(ticketing, "NotTicketOwner");
    });

    it("el organizador retira fondos solo despues de finalizado el evento", async function () {
      const { ticketing, usdc, organizer, alice, end } = await loadFixture(deployFixture);
      await ticketing.connect(alice).buyTickets(1, 2);
      await expect(ticketing.connect(organizer).withdrawProceeds(1)).to.be.revertedWithCustomError(ticketing, "WithdrawNotAvailable");
      await time.increaseTo(end + 1);
      await expect(ticketing.connect(alice).withdrawProceeds(1)).to.be.revertedWithCustomError(ticketing, "Unauthorized");
      await expect(ticketing.connect(organizer).withdrawProceeds(1)).to.emit(ticketing, "ProceedsWithdrawn").withArgs(1, organizer.address, PRICE * 2n);
      expect(await usdc.balanceOf(organizer.address)).to.equal(PRICE * 2n);
      await expect(ticketing.connect(organizer).withdrawProceeds(1)).to.be.revertedWithCustomError(ticketing, "NothingToWithdraw");
    });

    it("en eventos cancelados el retiro espera la ventana de reembolso", async function () {
      const { ticketing, organizer, alice, end } = await loadFixture(deployFixture);
      await ticketing.connect(alice).buyTickets(1, 1);
      await ticketing.connect(organizer).cancelEvent(1);
      await time.increaseTo(end + 1);
      await expect(ticketing.connect(organizer).withdrawProceeds(1)).to.be.revertedWithCustomError(ticketing, "WithdrawNotAvailable");
      await time.increaseTo(end + 30 * DAY + 1);
      await expect(ticketing.connect(organizer).withdrawProceeds(1)).to.emit(ticketing, "ProceedsWithdrawn");
    });
  });

  describe("MockUSDC", function () {
    it("usa 6 decimales y limita el faucet", async function () {
      const { usdc, alice } = await loadFixture(deployFixture);
      expect(await usdc.decimals()).to.equal(6);
      await expect(usdc.mint(alice.address, 10_000_000_001n)).to.be.revertedWithCustomError(usdc, "MintTooLarge");
    });
  });
});

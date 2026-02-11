(() => {
  "use strict";
  const C = window.OWNER_CONFIG;

  const $ = (id)=>document.getElementById(id);
  const setText = (id,t)=>{ const el=$(id); if(el) el.textContent=t; };
  const shortAddr = (a)=>a?(a.slice(0,6)+"..."+a.slice(-4)):"-";
  const toast = (m)=>setText("status", m||"");

  const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)"
  ];

  const CORE_ABI = [
    "function owner() view returns (address)",
    "function treasury() view returns (address)",
    "function defaultSponsor() view returns (address)",
    "function setTreasury(address t)",
    "function setDefaultSponsor(address s)",
    "function packageCount() view returns (uint256)",
    "function packages(uint256) view returns (bool active,uint256 usdtPrice,uint256 thbcAmount,uint256 apyBP,uint256 lockSeconds,uint8 rank)",
    "function setPackage(uint256 id,bool active,uint256 usdtPrice,uint256 thbcAmount,uint256 apyBP,uint256 lockSeconds,uint8 rank)",
    "function transferOwnership(address newOwner)",
    "function vault() view returns (address)",
    "function stake365() view returns (address)",
    "function earnings() view returns (address)"
  ];

  // EarningsV2 ABI (ตามที่คุณส่งมา)
  const EARN_ABI = [
    "function owner() view returns (address)",
    "function core() view returns (address)",
    "function referral() view returns (address)",
    "function reserve() view returns (address)",
    "function bufferBP() view returns (uint16)",
    "function setCore(address c)",
    "function setReferral(address r)",
    "function setReserve(address r)",
    "function setBufferBP(uint16 bp)",
    "function setCaps(uint256 b,uint256 s,uint256 g)",
    "function setRates(uint16[3] bronze_,uint16[3] silver_,uint16[3] gold_,uint16[3] match_)",
    "function ownerGrantRank(address u,uint8 r,bool active_)",
    "function withdrawableExcess() view returns (uint256)",
    "function sweepExcessToReserve(uint256 amount)",
    "function users(address) view returns (uint8 rank,bool active,uint256 paidTotal,uint256 accruedRef,uint256 accruedMatch,uint256 claimedTotal)"
  ];

  const VAULT_ABI = [
    "function owner() view returns (address)",
    "function core() view returns (address)",
    "function thbcToKJCRate() view returns (uint256)",
    "function rateLocked() view returns (bool)",
    "function setCore(address c)",
    "function setRate(uint256 newRate)",
    "function lockRate()",
    "function ownerDepositKJC(uint256 amount)",
    "function ownerWithdrawKJC(uint256 amount)",
    "function transferOwnership(address newOwner)"
  ];

  const STAKE_ABI = [
    "function owner() view returns (address)",
    "function core() view returns (address)",
    "function reservedTotal() view returns (uint256)",
    "function setCore(address c)",
    "function ownerDepositKJC(uint256 amount)",
    "function transferOwnership(address newOwner)"
  ];

  let provider, signer, me;
  let core, earn, vault, stake, usdt;
  let usdtDec = 18;

  async function chainId(){
    const cid = await provider.send("eth_chainId", []);
    if (typeof cid === "string" && cid.startsWith("0x")) return parseInt(cid,16);
    return Number(cid);
  }

  async function ensureBSC(){
    const cid = await chainId();
    setText("chain", String(cid));
    if (cid === C.CHAIN_ID_DEC) return true;
    try{
      await provider.send("wallet_switchEthereumChain", [{ chainId: C.CHAIN_ID_HEX }]);
      setText("chain", String(await chainId()));
      return true;
    }catch{
      toast(`กรุณาเปลี่ยนเป็น BNB Chain (chainId ${C.CHAIN_ID_DEC})`);
      return false;
    }
  }

  function fmtAmt(x, dec=18, dp=4){
    const b = BigInt(x);
    const base = 10n ** BigInt(dec);
    const i = b / base;
    const f = (b % base).toString().padStart(dec,"0").slice(0, dp);
    return `${i}.${f}`;
  }

  async function connect(){
    if (!window.ethereum) return toast("ไม่พบกระเป๋า");
    provider = new ethers.BrowserProvider(window.ethereum, "any");
    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    me = await signer.getAddress();

    setText("wallet", shortAddr(me));
    await ensureBSC();

    core  = new ethers.Contract(C.CORE, CORE_ABI, provider);
    earn  = new ethers.Contract(C.EARNINGS, EARN_ABI, provider);
    vault = new ethers.Contract(C.VAULT, VAULT_ABI, provider);
    stake = new ethers.Contract(C.STAKE365, STAKE_ABI, provider);
    usdt  = new ethers.Contract(C.USDT, ERC20_ABI, provider);

    try{ usdtDec = Number(await usdt.decimals()); }catch{ usdtDec = 18; }

    await refreshAll();
    toast("✅ Connected");

    window.ethereum.on?.("accountsChanged", ()=>location.reload());
    window.ethereum.on?.("chainChanged", ()=>location.reload());
  }

  async function refreshAll(){
    // CORE
    const co = await core.owner();
    setText("coreOwner", shortAddr(co));
    setText("coreTreasury", shortAddr(await core.treasury()));
    setText("coreDefaultSponsor", shortAddr(await core.defaultSponsor()));

    // EARN
    setText("earnOwner", shortAddr(await earn.owner()));
    setText("earnCore", shortAddr(await earn.core()));
    setText("earnRef", shortAddr(await earn.referral()));
    setText("earnReserve", shortAddr(await earn.reserve()));
    setText("earnBuffer", String(await earn.bufferBP()));

    // VAULT
    setText("vaultOwner", shortAddr(await vault.owner()));
    setText("vaultCore", shortAddr(await vault.core()));
    setText("vaultRate", (await vault.thbcToKJCRate()).toString());
    setText("vaultLocked", String(await vault.rateLocked()));

    // STAKE
    setText("stakeOwner", shortAddr(await stake.owner()));
    setText("stakeCore", shortAddr(await stake.core()));
    setText("stakeReserved", (await stake.reservedTotal()).toString());

    // excess
    try{
      const ex = await earn.withdrawableExcess();
      setText("earnExcess", fmtAmt(ex, usdtDec, 4));
    }catch{}
  }

  // ---------- CoreV4: setPackage ----------
  async function setPackage(){
    if (!await ensureBSC()) return;
    const id = Number($("pkgId").value);
    const active = $("pkgActive").value === "true";
    const usdtPrice = ethers.parseUnits($("pkgUsdt").value || "0", usdtDec);
    const thbcAmount = ethers.parseUnits($("pkgThbc").value || "0", 18);
    const apyBP = BigInt($("pkgApy").value || "0");
    const lockSeconds = BigInt($("pkgLock").value || "0");
    const rank = Number($("pkgRank").value || "0");

    toast("กำลัง setPackage...");
    const tx = await core.connect(signer).setPackage(id, active, usdtPrice, thbcAmount, apyBP, lockSeconds, rank);
    toast("รอยืนยัน tx setPackage...");
    await tx.wait();
    toast("✅ setPackage สำเร็จ");
    await refreshAll();
  }

  async function setTreasury(){
    if (!await ensureBSC()) return;
    const t = $("newTreasury").value.trim();
    toast("กำลัง setTreasury...");
    const tx = await core.connect(signer).setTreasury(t);
    await tx.wait();
    toast("✅ setTreasury สำเร็จ");
    await refreshAll();
  }

  async function setDefaultSponsor(){
    if (!await ensureBSC()) return;
    const s = $("newDefaultSponsor").value.trim();
    toast("กำลัง setDefaultSponsor...");
    const tx = await core.connect(signer).setDefaultSponsor(s);
    await tx.wait();
    toast("✅ setDefaultSponsor สำเร็จ");
    await refreshAll();
  }

  // ---------- Earnings: Offer / Set user ----------
  async function offerSetUser(){
    if (!await ensureBSC()) return;
    const u = $("targetUser").value.trim();
    const r = Number($("offerRank").value);
    const active = $("offerActive").value === "true";

    toast("กำลัง ownerGrantRank...");
    const tx = await earn.connect(signer).ownerGrantRank(u, r, active);
    toast("รอยืนยัน tx ownerGrantRank...");
    await tx.wait();
    toast("✅ Offer/Set User สำเร็จ");
    await refreshAll();
  }

  async function previewUser(){
    const u = $("targetUser").value.trim();
    if (!u) return;
    const x = await earn.users(u);
    toast(`users(u): rank=${Number(x.rank)} active=${x.active} paid=${x.paidTotal.toString()}`);
  }

  // ---------- Vault admin ----------
  async function vaultDeposit(){
    if (!await ensureBSC()) return;
    const amt = ethers.parseUnits($("vaultAmt").value || "0", 18);
    toast("กำลัง ownerDepositKJC (Vault)...");
    const tx = await vault.connect(signer).ownerDepositKJC(amt);
    await tx.wait();
    toast("✅ Vault deposit สำเร็จ");
  }
  async function vaultWithdraw(){
    if (!await ensureBSC()) return;
    const amt = ethers.parseUnits($("vaultAmt").value || "0", 18);
    toast("กำลัง ownerWithdrawKJC (Vault)...");
    const tx = await vault.connect(signer).ownerWithdrawKJC(amt);
    await tx.wait();
    toast("✅ Vault withdraw สำเร็จ");
  }
  async function vaultSetRate(){
    if (!await ensureBSC()) return;
    const rate = BigInt($("vaultRateIn").value || "0");
    toast("กำลัง setRate...");
    const tx = await vault.connect(signer).setRate(rate);
    await tx.wait();
    toast("✅ setRate สำเร็จ");
    await refreshAll();
  }
  async function vaultLockRate(){
    if (!await ensureBSC()) return;
    toast("กำลัง lockRate...");
    const tx = await vault.connect(signer).lockRate();
    await tx.wait();
    toast("✅ lockRate สำเร็จ");
    await refreshAll();
  }

  // ---------- Stake365 admin ----------
  async function stakeDeposit(){
    if (!await ensureBSC()) return;
    const amt = ethers.parseUnits($("stakeAmt").value || "0", 18);
    toast("กำลัง ownerDepositKJC (Stake365)...");
    const tx = await stake.connect(signer).ownerDepositKJC(amt);
    await tx.wait();
    toast("✅ Stake365 deposit สำเร็จ");
    await refreshAll();
  }

  // ---------- Earnings sweep excess ----------
  async function sweepExcess(){
    if (!await ensureBSC()) return;
    const amt = ethers.parseUnits($("sweepAmt").value || "0", usdtDec);
    toast("กำลัง sweepExcessToReserve...");
    const tx = await earn.connect(signer).sweepExcessToReserve(amt);
    await tx.wait();
    toast("✅ sweep สำเร็จ");
    await refreshAll();
  }

  function bind(){
    $("btnConnect").onclick = connect;
    $("btnRefresh").onclick = refreshAll;

    $("btnSetPackage").onclick = setPackage;
    $("btnSetTreasury").onclick = setTreasury;
    $("btnSetDefaultSponsor").onclick = setDefaultSponsor;

    $("btnOffer").onclick = offerSetUser;
    $("btnPreview").onclick = previewUser;

    $("btnVaultDep").onclick = vaultDeposit;
    $("btnVaultWit").onclick = vaultWithdraw;
    $("btnVaultRate").onclick = vaultSetRate;
    $("btnVaultLock").onclick = vaultLockRate;

    $("btnStakeDep").onclick = stakeDeposit;

    $("btnSweep").onclick = sweepExcess;
  }

  window.addEventListener("DOMContentLoaded", bind);
})();

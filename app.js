(() => {
  "use strict";
  const C = window.APP_CONFIG;

  // ---------- ABIs (minimal) ----------
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
    "function packageCount() view returns (uint256)",
    "function packages(uint256) view returns (bool active,uint256 usdtPrice,uint256 thbcAmount,uint256 apyBP,uint256 lockSeconds,uint8 rank)",
    "function buy(uint256 pkgId,address sponsor,uint8 side)",
    "event Bought(address indexed user,uint256 indexed pkgId,uint256 usdtPaid,uint256 thbcAmount,uint256 kjcStaked,uint256 stakeIndex,address sponsor,uint8 side)"
  ];

  const EARN_ABI = [
    "function users(address) view returns (uint8 rank,bool active,uint256 paidTotal,uint256 accruedRef,uint256 accruedMatch,uint256 claimedTotal)",
    "function withdrawableEarnings(address) view returns (uint256)",
    "function claimReferral(uint256 amount)",
    "function claimMatching(uint256 amount)"
  ];

  const STAKE_ABI = [
    "function stakes(address,uint256) view returns (uint256 principal,uint256 dailyBP,uint256 startTs,uint256 endTs,uint256 totalReward,bool claimed)",
    "function claim(uint256 index)",
    "function reservedTotal() view returns (uint256)"
  ];

  // ---------- DOM helpers ----------
  const $ = (id) => document.getElementById(id);
  const setText = (id, t) => { const el = $(id); if (el) el.textContent = t; };
  const setHTML = (id, h) => { const el = $(id); if (el) el.innerHTML = h; };
  const shortAddr = (a) => a ? (a.slice(0,6)+"..."+a.slice(-4)) : "-";
  const toBN = (v) => { try { return BigInt(v); } catch { return 0n; } };

  const zeroAddr = "0x0000000000000000000000000000000000000000";

  // ---------- State ----------
  let provider, signer, user;
  let core, usdt, earn, stake;
  let usdtDec = 18;

  // ---------- URL params ----------
  function getParam(name){
    const u = new URL(window.location.href);
    return u.searchParams.get(name) || "";
  }
  function getSideParam(){
    const s = (getParam(C.SIDE_PARAM) || "").toUpperCase();
    if (s === "R" || s === "RIGHT") return 1;
    return 0; // default Left
  }

  // ---------- Chain check (กันทุก format) ----------
  async function getChainId(){
    const cid = await provider.send("eth_chainId", []);
    // cid can be "0x38" or number-like string
    if (typeof cid === "string" && cid.startsWith("0x")) return Number.parseInt(cid, 16);
    return Number(cid);
  }

  async function ensureBSC(){
    const cid = await getChainId();
    setText("chainBadge", String(cid));
    if (cid === C.CHAIN_ID_DEC) return true;

    // try switch/add
    try{
      await provider.send("wallet_switchEthereumChain", [{ chainId: C.CHAIN_ID_HEX }]);
      const cid2 = await getChainId();
      setText("chainBadge", String(cid2));
      return cid2 === C.CHAIN_ID_DEC;
    }catch(e){
      // add chain then switch
      try{
        await provider.send("wallet_addEthereumChain", [{
          chainId: C.CHAIN_ID_HEX,
          chainName: C.CHAIN_NAME,
          rpcUrls: [C.RPC_URL],
          nativeCurrency: { name:"BNB", symbol:"BNB", decimals:18 },
          blockExplorerUrls: [C.BLOCK_EXPLORER]
        }]);
        const cid3 = await getChainId();
        setText("chainBadge", String(cid3));
        return cid3 === C.CHAIN_ID_DEC;
      }catch(_e){
        toast(`กรุณาเปลี่ยนเป็น BNB Chain (chainId ${C.CHAIN_ID_DEC})`);
        return false;
      }
    }
  }

  // ---------- UI toast ----------
  function toast(msg){
    setText("status", msg || "");
  }

  function fmtAmt(x, dec=18, dp=6){
    const b = toBN(x);
    const base = 10n ** BigInt(dec);
    const i = b / base;
    const f = b % base;
    const fs = f.toString().padStart(dec, "0").slice(0, dp);
    return `${i.toString()}.${fs}`;
  }

  // ---------- Load packages ----------
  async function loadPackages(){
    const n = Number(await core.packageCount());
    const sel = $("pkg");
    sel.innerHTML = "";
    for (let i=0;i<n;i++){
      const p = await core.packages(i);
      const active = p.active;
      const usdtPrice = p.usdtPrice;
      const thbcAmount = p.thbcAmount;
      const apyBP = p.apyBP;
      const lockSeconds = p.lockSeconds;
      const rank = Number(p.rank);

      const opt = document.createElement("option");
      opt.value = String(i);

      const rankName = ["None","Bronze","Silver","Gold"][rank] ?? `R${rank}`;
      opt.textContent =
        `#${i} ${fmtAmt(usdtPrice, usdtDec, 2)} USDT (${rankName})  | THBC ${fmtAmt(thbcAmount,18,0)} | APY ${Number(apyBP)/100}% | Lock ${Math.round(Number(lockSeconds)/86400)}d`
      ;
      if (!active) opt.textContent = "⛔ " + opt.textContent;
      sel.appendChild(opt);
    }
  }

  // ---------- Refresh balances + user info ----------
  async function refresh(){
    if (!user) return;

    const bal = await usdt.balanceOf(user);
    const alw = await usdt.allowance(user, C.CORE);

    setText("usdtBal", fmtAmt(bal, usdtDec, 4));
    setText("usdtAlw", fmtAmt(alw, usdtDec, 4));

    // earnings user
    try{
      const u = await earn.users(user);
      const rank = Number(u.rank);
      const active = u.active;

      setText("myRank", ["None","Bronze","Silver","Gold"][rank] ?? String(rank));
      setText("myStatus", active ? "OK_SHARE" : "NEED_BUY");

      setText("accrRef", fmtAmt(u.accruedRef, usdtDec, 4));
      setText("accrMatch", fmtAmt(u.accruedMatch, usdtDec, 4));

      const w = await earn.withdrawableEarnings(user);
      setText("withdrawable", fmtAmt(w, usdtDec, 4));
    }catch(e){
      // ถ้า earnings ไม่ตอบ ก็ไม่ทำให้หน้า crash
      console.log("earnings read err", e);
    }

    // stakes count
    try{
      const c = await core.userStakeCount(user);
      setText("stakeCount", String(c));
    }catch(_){}
  }

  // ---------- Approve ----------
  async function approveUSDT(){
    if (!await ensureBSC()) return;
    toast("กำลังขออนุมัติ USDT...");
    const amt = (2n**256n - 1n); // infinite
    const tx = await usdt.connect(signer).approve(C.CORE, amt);
    toast("รอยืนยันธุรกรรม Approve...");
    await tx.wait();
    toast("✅ Approve สำเร็จ");
    await refresh();
  }

  // ---------- Buy ----------
  async function buy(){
    if (!await ensureBSC()) return;

    const pkgId = Number($("pkg").value);
    let sponsor = ($("sponsor").value || "").trim();
    if (!sponsor) sponsor = getParam(C.REF_PARAM) || "";
    if (!sponsor) sponsor = zeroAddr;

    const side = $("side").value === "R" ? 1 : 0;

    // ถ้า sponsor เป็นศูนย์ ให้ใช้ defaultSponsor ของ Core
    if (sponsor.toLowerCase() === zeroAddr.toLowerCase()){
      const d = await core.defaultSponsor();
      sponsor = d && d !== zeroAddr ? d : zeroAddr;
    }

    toast("กำลังซื้อแพ็กเกจ...");
    const tx = await core.connect(signer).buy(pkgId, sponsor, side);
    toast("รอยืนยันธุรกรรม Buy...");
    const rc = await tx.wait();
    toast("✅ Buy สำเร็จ");

    // parse event Bought
    try{
      const ev = rc.logs.map(l=>{
        try{return core.interface.parseLog(l);}catch{return null;}
      }).find(x=>x && x.name==="Bought");
      if (ev){
        const stakeIndex = ev.args.stakeIndex?.toString?.() ?? "";
        toast(`✅ Buy สำเร็จ | stakeIndex: ${stakeIndex}`);
      }
    }catch(_){}

    await refresh();
  }

  // ---------- Claim helpers ----------
  async function claimReferral(){
    if (!await ensureBSC()) return;
    const amt = $("claimRefAmt").value.trim();
    if (!amt) return toast("ใส่จำนวน USDT ที่จะเคลม referral");
    const wei = ethers.parseUnits(amt, usdtDec);
    toast("กำลังเคลม Referral...");
    const tx = await earn.connect(signer).claimReferral(wei);
    toast("รอยืนยันธุรกรรม Claim Referral...");
    await tx.wait();
    toast("✅ เคลม Referral สำเร็จ");
    await refresh();
  }

  async function claimMatching(){
    if (!await ensureBSC()) return;
    const amt = $("claimMatchAmt").value.trim();
    if (!amt) return toast("ใส่จำนวน USDT ที่จะเคลม matching");
    const wei = ethers.parseUnits(amt, usdtDec);
    toast("กำลังเคลม Matching...");
    const tx = await earn.connect(signer).claimMatching(wei);
    toast("รอยืนยันธุรกรรม Claim Matching...");
    await tx.wait();
    toast("✅ เคลม Matching สำเร็จ");
    await refresh();
  }

  // ---------- Referral link ----------
  function buildRefLink(sideLetter){
    const base = window.location.origin + window.location.pathname;
    const ref = user || "";
    const url = new URL(base);
    if (ref) url.searchParams.set(C.REF_PARAM, ref);
    url.searchParams.set(C.SIDE_PARAM, sideLetter);
    return url.toString();
  }
  async function copy(text){
    await navigator.clipboard.writeText(text);
    toast("✅ Copy แล้ว");
  }

  // ---------- Connect ----------
  async function connect(){
    if (!window.ethereum) return toast("ไม่พบกระเป๋า (window.ethereum)");
    provider = new ethers.BrowserProvider(window.ethereum, "any");

    try{
      await provider.send("eth_requestAccounts", []);
      signer = await provider.getSigner();
      user = await signer.getAddress();

      setText("wallet", shortAddr(user));
      setHTML("bscLink", `<a class="pill mono" target="_blank" rel="noreferrer" href="${C.BLOCK_EXPLORER}/address/${user}">BscScan</a>`);

      // init contracts
      core = new ethers.Contract(C.CORE, CORE_ABI, provider);
      usdt = new ethers.Contract(C.USDT, ERC20_ABI, provider);
      earn = new ethers.Contract(C.EARNINGS, EARN_ABI, provider);
      stake = new ethers.Contract(C.STAKE365, STAKE_ABI, provider);

      // decimals
      try{ usdtDec = Number(await usdt.decimals()); }catch{ usdtDec = 18; }

      // chain check
      await ensureBSC();

      // fill sponsor from URL (if exists)
      const urlRef = getParam(C.REF_PARAM);
      if (urlRef) $("sponsor").value = urlRef;

      // side from URL
      $("side").value = (getSideParam() === 1) ? "R" : "L";

      await loadPackages();
      await refresh();

      // show ref link
      setText("myRefLink", buildRefLink($("side").value));
      toast("✅ Connected");

      // listeners
      window.ethereum.on?.("accountsChanged", ()=>window.location.reload());
      window.ethereum.on?.("chainChanged", ()=>window.location.reload());

    }catch(e){
      console.log(e);
      toast("เชื่อมต่อไม่สำเร็จ");
    }
  }

  // ---------- bind ----------
  function bind(){
    $("btnConnect").onclick = connect;
    $("btnApprove").onclick = approveUSDT;
    $("btnBuy").onclick = buy;
    $("btnRefresh").onclick = refresh;
    $("btnClaimRef").onclick = claimReferral;
    $("btnClaimMatch").onclick = claimMatching;

    $("side").onchange = ()=>{
      if (!user) return;
      setText("myRefLink", buildRefLink($("side").value));
    };

    $("btnCopyLeft").onclick = ()=>copy(buildRefLink("L"));
    $("btnCopyRight").onclick = ()=>copy(buildRefLink("R"));
    $("btnCopyAddr").onclick = ()=>copy(user || "");

    // show core addr
    setText("coreAddr", C.CORE);
    setHTML("coreScan", `<a class="pill" target="_blank" rel="noreferrer" href="${C.BLOCK_EXPLORER}/address/${C.CORE}">Core Scan</a>`);
  }

  // ---------- boot ----------
  window.addEventListener("DOMContentLoaded", bind);
})();

import React, { useState, useEffect } from 'react'
import App from './App.jsx'

const DEMO_PIN = '2025'
const STORAGE_KEY = 'siq_demo_unlocked'

/* ── Demo seed data (same as demo-seed.js but built-in) ── */
function seedDemoData() {
  const prefix = 'siq_';
  Object.keys(localStorage).forEach(k => {
    if (k.startsWith(prefix)) localStorage.removeItem(k);
  });

  const now = new Date().toISOString();
  const orgId = 'org_demo_001';
  const userId = 'user_demo_001';

  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }

  const org = {
    id:orgId, name:'Acme Fashions Ltd', gstin:'27AABCA1234C1Z5',
    plan:'growth', billingCycle:'annual', subscriptionStatus:'active',
    trialEnds:new Date(Date.now()+14*86400000).toISOString(),
    reportingYear:'FY 2024-25', industry:'Apparel & Textile',
    cin:'L17110MH2001PLC123456', aiReportsUsed:3,
    nextBillingDate:new Date(Date.now()+365*86400000).toISOString(),
    subscriptionStart:now, created_at:now
  };

  const users = [
    { id:userId, email:'demo@acmefashions.in', passwordHash:hash('demo123'), firstName:'Nirav', lastName:'Mehta', orgId, role:'admin', isActive:true, lastLogin:now, created_at:now },
    { id:'user_demo_002', email:'priya@acmefashions.in', passwordHash:hash('priya123'), firstName:'Priya', lastName:'Sharma', orgId, role:'manager', dept:'Environment & Facilities', isActive:true, lastLogin:now, created_at:now },
    { id:'user_demo_003', email:'rahul@acmefashions.in', passwordHash:hash('rahul123'), firstName:'Rahul', lastName:'Verma', orgId, role:'contributor', dept:'Human Resources', isActive:true, lastLogin:now, created_at:now },
    { id:'user_demo_004', email:'anita@acmefashions.in', passwordHash:hash('anita123'), firstName:'Anita', lastName:'Joshi', orgId, role:'contributor', dept:'Finance & Accounts', isActive:true, lastLogin:now, created_at:now },
  ];

  const invoice = { id:'inv_001', orgId, userId, orderId:'SIQ-DEMO01', plan:'growth', billingCycle:'annual', amount:149999, gst:26999, total:176998, paymentMethod:'card', cardLast4:'1111', status:'paid', paidAt:new Date(Date.now()-30*86400000).toISOString(), nextBillingDate:new Date(Date.now()+335*86400000).toISOString(), created_at:now };

  const esgModules = {
    emissions:{ scope1_gas:'1840', scope1_fleet:'1360', scope2_elec:'4200', scope2_steam:'1440', scope3_travel:'1200', scope3_supply:'2800', elec_total:'14500000', elec_renewable:'74', re_solar:'30', re_wind:'26', re_hydro:'18', carbon_intensity:'2.14', netzero_year:'2040' },
    water:{ water_surface:'1200', water_ground:'2400', water_municipal:'610', water_recycled:'1840', water_intensity:'0.71', water_target:'0.65', waste_total:'892', waste_recycled:'624', waste_landfill:'268', waste_hazardous:'48' },
    social:{ headcount_total:'2840', headcount_perm:'2210', headcount_contract:'630', women_total:'38', women_senior:'42', women_board:'33', pay_entry:'0.98', pay_mid:'0.94', pay_senior:'0.89', training_hrs:'38', attrition:'12.4', ltifr:'0.34' },
    governance:{ board_independence:'67', esg_committee:'Yes', whistle_cases:'12', whistle_resolved:'11', csr_spend:'4.2', csr_pct:'2.1', csr_beneficiaries:'12400', revenue:'599', ebitda_margin:'14.2', suppliers_total:'48', suppliers_assessed:'40', suppliers_high_risk:'3' },
    supply:{ suppliers_total:'48', suppliers_assessed:'40', suppliers_high_risk:'3', suppliers_audited_pct:'40', suppliers_avg_score:'82', supply_notes:'Key risks: water stress in Gujarat, labor compliance in Bangladesh tier-2. Mitigation: annual audits, ESG questionnaire for all tier-1.' }
  };

  const esgData = Object.entries(esgModules).map(([module,data]) => ({ id:`esg_${module}`, orgId, module, data:JSON.stringify(data), updatedBy:userId, created_at:now, updated_at:now }));

  const TASKS = [
    {t:'Scope 1 GHG Emissions',d:'Environment & Facilities',p:'high',fw:['BRSR','GRI','TCFD'],m:'emissions',s:'submitted',a:'Priya Sharma',v:'1,840 tCO2e'},
    {t:'Scope 2 Electricity Consumption',d:'Environment & Facilities',p:'high',fw:['BRSR','GRI','TCFD'],m:'emissions',s:'submitted',a:'Priya Sharma',v:'4,200 tCO2e'},
    {t:'Water Withdrawal by Source',d:'Environment & Facilities',p:'high',fw:['BRSR','GRI'],m:'water',s:'submitted',a:'Priya Sharma',v:'4,210 ML'},
    {t:'Waste Generation & Disposal',d:'Environment & Facilities',p:'medium',fw:['BRSR','GRI','SASB'],m:'water',s:'in_progress',a:'Priya Sharma',v:null},
    {t:'Renewable Energy Certificates',d:'Environment & Facilities',p:'medium',fw:['BRSR','GRI'],m:'emissions',s:'in_progress',a:'Priya Sharma',v:null},
    {t:'Total Headcount by Gender',d:'Human Resources',p:'high',fw:['BRSR','GRI'],m:'social',s:'submitted',a:'Rahul Verma',v:'2,840 employees'},
    {t:'Pay Equity Analysis',d:'Human Resources',p:'high',fw:['BRSR'],m:'social',s:'submitted',a:'Rahul Verma',v:'0.94 ratio'},
    {t:'Training Hours per Employee',d:'Human Resources',p:'medium',fw:['BRSR','GRI'],m:'social',s:'submitted',a:'Rahul Verma',v:'38 hrs'},
    {t:'Attrition Rate & Reasons',d:'Human Resources',p:'medium',fw:['BRSR'],m:'social',s:'in_progress',a:'Rahul Verma',v:null},
    {t:'LTIFR & Safety Incidents',d:'Operations & EHS',p:'high',fw:['BRSR','GRI','SASB'],m:'social',s:'submitted',a:'Kavita Reddy',v:'0.34 LTIFR'},
    {t:'CSR Spend & Project Details',d:'Finance & Accounts',p:'high',fw:['BRSR'],m:'governance',s:'submitted',a:'Anita Joshi',v:'Rs 4.2 Cr'},
    {t:'Revenue & Financial Metrics',d:'Finance & Accounts',p:'medium',fw:['BRSR','SASB'],m:'governance',s:'submitted',a:'Anita Joshi',v:'Rs 599 Cr'},
    {t:'Business Travel Scope 3',d:'Finance & Accounts',p:'medium',fw:['BRSR','GRI','TCFD'],m:'emissions',s:'submitted',a:'Anita Joshi',v:'1,200 tCO2e'},
    {t:'Supplier ESG Questionnaire',d:'Procurement / SCM',p:'high',fw:['BRSR','GRI','SASB'],m:'supply',s:'in_progress',a:'Deepak Singh',v:null},
    {t:'Tier-2 Supplier Risk Assessment',d:'Procurement / SCM',p:'medium',fw:['GRI','SASB'],m:'supply',s:'not_started',a:'Deepak Singh',v:null},
    {t:'Board Independence Charter',d:'Legal & Compliance',p:'high',fw:['BRSR','TCFD'],m:'governance',s:'in_progress',a:'Sameer Patel',v:null},
    {t:'Whistleblower Policy & Cases',d:'Legal & Compliance',p:'medium',fw:['BRSR','GRI'],m:'governance',s:'not_started',a:'Sameer Patel',v:null},
    {t:'Biodiversity Impact Assessment',d:'Environment & Facilities',p:'low',fw:['GRI'],m:'water',s:'not_started',a:'Priya Sharma',v:null},
  ];
  const due = new Date(Date.now()+30*86400000).toISOString().split('T')[0];
  const tasks = TASKS.map((t,i) => ({ id:`task_${String(i+1).padStart(3,'0')}`, title:t.t, dept:t.d, priority:t.p, fw:JSON.stringify(t.fw), module:t.m, status:t.s, assigneeName:t.a, assigneeId:userId, value:t.v, notes:'', orgId, due, created_at:now }));

  const auditLog = [
    {id:'al_001',userId,orgId,type:'auth',action:'User logged in',meta:'{}',timestamp:now},
    {id:'al_002',userId:'user_demo_002',orgId,type:'data_entry',action:'Updated emissions data',meta:JSON.stringify({changes:['scope1_gas: -- -> 1840','scope2_elec: -- -> 4200']}),timestamp:new Date(Date.now()-3600000).toISOString()},
    {id:'al_003',userId:'user_demo_003',orgId,type:'data_entry',action:'Updated social data',meta:JSON.stringify({changes:['headcount_total: -- -> 2840','women_senior: -- -> 42']}),timestamp:new Date(Date.now()-7200000).toISOString()},
    {id:'al_004',userId:'user_demo_004',orgId,type:'data_entry',action:'Updated governance data',meta:JSON.stringify({changes:['csr_spend: -- -> 4.2','revenue: -- -> 599']}),timestamp:new Date(Date.now()-10800000).toISOString()},
    {id:'al_005',userId,orgId,type:'workflow',action:'Task "Scope 1 GHG Emissions" -> submitted',meta:'{}',timestamp:new Date(Date.now()-14400000).toISOString()},
    {id:'al_006',userId,orgId,type:'billing',action:'Subscription activated: Growth (annual)',meta:JSON.stringify({orderId:'SIQ-DEMO01',total:176998}),timestamp:new Date(Date.now()-30*86400000).toISOString()},
    {id:'al_007',userId,orgId,type:'team',action:'Invited priya@acmefashions.in as manager',meta:JSON.stringify({email:'priya@acmefashions.in',role:'manager'}),timestamp:new Date(Date.now()-25*86400000).toISOString()},
  ];

  const notifications = [
    {id:'n1',orgId,message:'Priya Sharma submitted Water Withdrawal data',read:false,timestamp:new Date(Date.now()-1800000).toISOString()},
    {id:'n2',orgId,message:'Supplier ESG Questionnaire due in 5 days -- action needed',read:false,timestamp:new Date(Date.now()-3600000).toISOString()},
    {id:'n3',orgId,message:'Pay equity ratio below 0.95 target at senior level',read:false,timestamp:new Date(Date.now()-7200000).toISOString()},
    {id:'n4',orgId,message:'Rahul Verma joined as Contributor',read:true,timestamp:new Date(Date.now()-86400000).toISOString()},
    {id:'n5',orgId,message:'BRSR report generated and saved to Report History',read:true,timestamp:new Date(Date.now()-172800000).toISOString()},
  ];

  const depts = [
    {id:'d1',orgId,name:'Environment & Facilities',icon:'ENV',ownerId:'user_demo_002',ownerName:'Priya Sharma',color:'#1a7a4a',created_at:now},
    {id:'d2',orgId,name:'Human Resources',icon:'HR',ownerId:'user_demo_003',ownerName:'Rahul Verma',color:'#2d4fd4',created_at:now},
    {id:'d3',orgId,name:'Finance & Accounts',icon:'FIN',ownerId:'user_demo_004',ownerName:'Anita Joshi',color:'#7c3aed',created_at:now},
    {id:'d4',orgId,name:'Procurement / SCM',icon:'SCM',ownerId:userId,ownerName:'Deepak Singh',color:'#b45309',created_at:now},
    {id:'d5',orgId,name:'Operations & EHS',icon:'OPS',ownerId:userId,ownerName:'Kavita Reddy',color:'#c2410c',created_at:now},
    {id:'d6',orgId,name:'Legal & Compliance',icon:'LEG',ownerId:userId,ownerName:'Sameer Patel',color:'#374151',created_at:now},
  ];

  localStorage.setItem(`${prefix}orgs`, JSON.stringify([org]));
  localStorage.setItem(`${prefix}users`, JSON.stringify(users));
  localStorage.setItem(`${prefix}invoices`, JSON.stringify([invoice]));
  localStorage.setItem(`${prefix}esg_data`, JSON.stringify(esgData));
  localStorage.setItem(`${prefix}tasks`, JSON.stringify(tasks));
  localStorage.setItem(`${prefix}audit_log`, JSON.stringify(auditLog));
  localStorage.setItem(`${prefix}notifications`, JSON.stringify(notifications));
  localStorage.setItem(`${prefix}departments`, JSON.stringify(depts));
  localStorage.setItem(`${prefix}reports`, JSON.stringify([]));
}

/* ── Styles ── */
const S = `
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{background:#0c130c;font-family:'Plus Jakarta Sans',sans-serif}
  .gate{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
    background:radial-gradient(ellipse 70% 50% at 50% 0%,rgba(23,102,57,0.22) 0%,transparent 60%),
               radial-gradient(ellipse 50% 40% at 80% 90%,rgba(196,82,8,0.1) 0%,transparent 50%),#0c130c}
  .card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:22px;
    padding:48px 40px;width:100%;max-width:440px;backdrop-filter:blur(20px)}
  .logo{width:58px;height:58px;background:linear-gradient(135deg,#176639,#22c55e);border-radius:15px;
    display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:900;color:white;
    margin:0 auto 22px;box-shadow:0 0 40px rgba(34,197,94,0.2)}
  h1{font-size:28px;font-weight:800;color:white;letter-spacing:-0.8px;margin-bottom:8px;text-align:center}
  h1 em{font-style:normal;color:#4ade80}
  .sub{font-size:13.5px;color:rgba(255,255,255,0.38);line-height:1.65;margin-bottom:28px;text-align:center}
  .badges{display:flex;gap:7px;justify-content:center;margin-bottom:28px;flex-wrap:wrap}
  .badge{padding:3px 10px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:0.5px}
  .b1{background:rgba(196,82,8,0.15);color:#fb923c;border:1px solid rgba(196,82,8,0.25)}
  .b2{background:rgba(23,102,57,0.15);color:#4ade80;border:1px solid rgba(23,102,57,0.25)}
  .b3{background:rgba(26,63,168,0.15);color:#93c5fd;border:1px solid rgba(26,63,168,0.25)}
  .b4{background:rgba(154,111,0,0.15);color:#fcd34d;border:1px solid rgba(154,111,0,0.25)}
  .tabs{display:flex;background:rgba(255,255,255,0.05);border-radius:10px;padding:4px;margin-bottom:22px}
  .tab{flex:1;padding:8px;text-align:center;border-radius:7px;font-size:13px;font-weight:600;
    cursor:pointer;color:rgba(255,255,255,0.4);border:none;background:none;font-family:inherit;transition:all 0.13s}
  .tab.on{background:rgba(255,255,255,0.1);color:white}
  .lbl{font-size:10px;font-weight:700;color:rgba(255,255,255,0.35);letter-spacing:2px;
    text-transform:uppercase;display:block;margin-bottom:7px;text-align:left}
  input[type=password],input[type=email],input[type=text]{width:100%;padding:12px 16px;
    background:rgba(255,255,255,0.06);border:1.5px solid rgba(255,255,255,0.1);border-radius:10px;
    font-size:15px;color:white;outline:none;transition:all 0.14s;font-family:inherit;margin-bottom:12px}
  input:focus{border-color:#4ade80;background:rgba(74,222,128,0.07);box-shadow:0 0 0 3px rgba(74,222,128,0.1)}
  input.shake{animation:shake 0.4s ease;border-color:#f87171}
  @keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-7px)}75%{transform:translateX(7px)}}
  .btn{width:100%;padding:13px;background:linear-gradient(135deg,#176639,#22c55e);border:none;
    border-radius:10px;font-size:14px;font-weight:700;color:white;cursor:pointer;
    font-family:inherit;letter-spacing:-0.2px;transition:all 0.14s;margin-top:4px}
  .btn:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(34,197,94,0.25)}
  .btn:disabled{opacity:0.5;cursor:not-allowed;transform:none}
  .btn-demo{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
    color:rgba(255,255,255,0.6);margin-top:10px}
  .btn-demo:hover{background:rgba(255,255,255,0.1);color:white;transform:translateY(-1px)}
  .err{font-size:12px;color:#f87171;text-align:center;height:18px;margin-top:6px}
  .ok-msg{font-size:12px;color:#4ade80;text-align:center;margin-top:8px;height:18px}
  .divider{display:flex;align-items:center;gap:10px;margin:14px 0}
  .divider span{font-size:11px;color:rgba(255,255,255,0.2);white-space:nowrap}
  .divider::before,.divider::after{content:'';flex:1;height:1px;background:rgba(255,255,255,0.08)}
  .demo-box{background:rgba(74,222,128,0.05);border:1px solid rgba(74,222,128,0.15);
    border-radius:10px;padding:14px 16px;margin-bottom:12px}
  .demo-box p{font-size:12px;color:rgba(255,255,255,0.5);line-height:1.6;margin-bottom:8px}
  .demo-creds{font-family:'Courier New',monospace;font-size:12px;color:#4ade80;line-height:1.8}
  .footer{margin-top:24px;padding-top:18px;border-top:1px solid rgba(255,255,255,0.06);
    font-size:11px;color:rgba(255,255,255,0.18);text-align:center;line-height:1.7}
  .loader{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);
    border-top-color:white;border-radius:50%;animation:spin 0.7s linear infinite;margin-right:6px;vertical-align:middle}
  @keyframes spin{to{transform:rotate(360deg)}}
`

export default function Gate() {
  const [unlocked, setUnlocked]   = useState(false)
  const [tab, setTab]             = useState('investor') // 'investor' | 'login'
  const [pin, setPin]             = useState('')
  const [email, setEmail]         = useState('')
  const [password, setPassword]   = useState('')
  const [err, setErr]             = useState('')
  const [okMsg, setOkMsg]         = useState('')
  const [shake, setShake]         = useState(false)
  const [loading, setLoading]     = useState(false)
  const [demoLoaded, setDemoLoaded] = useState(false)

  useEffect(() => {
    if (sessionStorage.getItem(STORAGE_KEY) === 'true') setUnlocked(true)
  }, [])

  function doShake(msg) {
    setErr(msg); setShake(true)
    setTimeout(() => { setShake(false); setErr('') }, 1600)
  }

  function checkPin() {
    if (pin === DEMO_PIN) {
      sessionStorage.setItem(STORAGE_KEY, 'true')
      setUnlocked(true)
    } else {
      doShake('Incorrect access code')
      setPin('')
    }
  }

  function loginWithAccount() {
    if (!email.includes('@') || password.length < 3) { doShake('Enter valid email and password'); return; }
    setLoading(true)
    // Simulate async login check
    setTimeout(() => {
      // Use same hash as App.jsx
      function hash(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
        return h.toString(16).padStart(8, '0');
      }
      try {
        const users = JSON.parse(localStorage.getItem('siq_users') || '[]')
        const user = users.find(u => u.email === email.toLowerCase())
        if (!user || user.passwordHash !== hash(password)) {
          setLoading(false)
          doShake('Incorrect email or password')
          return
        }
        // Create session token
        const orgs = JSON.parse(localStorage.getItem('siq_orgs') || '[]')
        const org = orgs.find(o => o.id === user.orgId)
        if (!org) { setLoading(false); doShake('Organisation not found'); return; }
        const payload = { userId: user.id, orgId: user.orgId, role: user.role, email: user.email, exp: Date.now() + 86400000 * 7 }
        const token = btoa(JSON.stringify(payload))
        localStorage.setItem('siq_kv_session', JSON.stringify(token))
        setLoading(false)
        sessionStorage.setItem(STORAGE_KEY, 'true')
        setUnlocked(true)
      } catch(e) {
        setLoading(false)
        doShake('Login error - try loading demo data first')
      }
    }, 500)
  }

  function loadDemo() {
    setLoading(true)
    setTimeout(() => {
      seedDemoData()
      setDemoLoaded(true)
      setEmail('demo@acmefashions.in')
      setPassword('demo123')
      setLoading(false)
      setOkMsg('Demo data loaded! Click "Sign In" now.')
      setTimeout(() => setOkMsg(''), 4000)
    }, 800)
  }

  function handleKey(e) {
    if (e.key !== 'Enter') return
    if (tab === 'investor') checkPin()
    else loginWithAccount()
  }

  if (unlocked) return <App />

  return (
    <>
      <style>{S}</style>
      <div className="gate">
        <div className="card">
          <div className="logo">S</div>
          <h1>Sustain<em>IQ</em></h1>
          <p className="sub">India's first BRSR + GRI + SASB + TCFD ESG platform.<br/>Private investor & team access only.</p>

          <div className="badges">
            <span className="badge b1">BRSR</span>
            <span className="badge b2">GRI</span>
            <span className="badge b3">SASB</span>
            <span className="badge b4">TCFD</span>
          </div>

          <div className="tabs">
            <button className={`tab${tab==='investor'?' on':''}`} onClick={()=>{setTab('investor');setErr('')}}>Investor Demo</button>
            <button className={`tab${tab==='login'?' on':''}`} onClick={()=>{setTab('login');setErr('')}}>Team Login</button>
          </div>

          {tab === 'investor' && <>
            <div className="demo-box">
              <p>Enter the access code shared with you. This loads a fully populated demo with all ESG modules, workflow tasks, AI report generation, and billing.</p>
            </div>
            <label className="lbl">Access Code</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              placeholder="Enter code"
              value={pin}
              className={shake ? 'shake' : ''}
              onChange={e => setPin(e.target.value.replace(/\D/g,''))}
              onKeyDown={handleKey}
              autoFocus
              style={{textAlign:'center',letterSpacing:'6px',fontSize:20}}
            />
            <button className="btn" onClick={checkPin}>Enter Platform →</button>
            <div className="err">{err}</div>
          </>}

          {tab === 'login' && <>
            {!demoLoaded && <>
              <div className="demo-box">
                <p>First time? Load the demo dataset to see a fully active company dashboard with all data pre-filled.</p>
                <div className="demo-creds">
                  Email: demo@acmefashions.in<br/>
                  Password: demo123
                </div>
              </div>
              <button className="btn btn-demo" onClick={loadDemo} disabled={loading}>
                {loading ? <><span className="loader"/>Loading demo data...</> : '⬇ Load Demo Data & Fill Credentials'}
              </button>
              <div className="divider"><span>or sign in directly</span></div>
            </>}

            <label className="lbl">Email</label>
            <input
              type="email"
              placeholder="demo@acmefashions.in"
              value={email}
              className={shake ? 'shake' : ''}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={handleKey}
            />
            <label className="lbl">Password</label>
            <input
              type="password"
              placeholder="demo123"
              value={password}
              className={shake ? 'shake' : ''}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={handleKey}
            />
            <button className="btn" onClick={loginWithAccount} disabled={loading}>
              {loading ? <><span className="loader"/>Signing in...</> : 'Sign In →'}
            </button>
            <div className="err">{err}</div>
            <div className="ok-msg">{okMsg}</div>
          </>}

          <div className="footer">
            SustainIQ Technologies Pvt. Ltd. · Mumbai, India<br/>
            Investor demo · All data stored in your browser only<br/>
            AI reports require Anthropic API proxy (see DEPLOY.txt)
          </div>
        </div>
      </div>
    </>
  )
}

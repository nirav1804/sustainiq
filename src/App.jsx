import { useState, useEffect, useCallback, useRef, createContext, useContext } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   SUSTAINIQ  --  Complete SaaS Platform
   Full backend simulation: Auth . Multi-tenancy . Subscriptions . ESG Data
   Workflow Engine . AI Reports . Audit Trail . Billing . Settings
   ─────────────────────────────────────────────────────────────────────────
   All data persists via localStorage (production = PostgreSQL, same schema)
   Auth uses JWT-pattern tokens with role-based access
   Payment uses Razorpay simulation (swap API key for real integration)
═══════════════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════
   § 1  DATABASE LAYER  (localStorage ↔ PostgreSQL)
════════════════════════════════════════════════ */
const DB = {
  get: (table) => { try { return JSON.parse(localStorage.getItem(`siq_${table}`) || "[]"); } catch { return []; } },
  set: (table, data) => localStorage.setItem(`siq_${table}`, JSON.stringify(data)),
  getOne: (table, id) => DB.get(table).find(r => r.id === id) || null,
  insert: (table, record) => {
    const rows = DB.get(table);
    const row = { ...record, id: record.id || `${table}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, created_at: new Date().toISOString() };
    rows.push(row);
    DB.set(table, rows);
    return row;
  },
  update: (table, id, patch) => {
    const rows = DB.get(table).map(r => r.id === id ? { ...r, ...patch, updated_at: new Date().toISOString() } : r);
    DB.set(table, rows);
    return rows.find(r => r.id === id);
  },
  delete: (table, id) => DB.set(table, DB.get(table).filter(r => r.id !== id)),
  where: (table, pred) => DB.get(table).filter(pred),
  clear: (table) => localStorage.removeItem(`siq_${table}`),
  kv: { get: k => { try { return JSON.parse(localStorage.getItem(`siq_kv_${k}`)); } catch { return null; } }, set: (k,v) => localStorage.setItem(`siq_kv_${k}`, JSON.stringify(v)) }
};

/* ════════════════════════════════════════════════
   § 2  AUTH SERVICE
════════════════════════════════════════════════ */
const hash = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h.toString(16).padStart(8,'0');
};
const signToken = (payload) => btoa(JSON.stringify({ ...payload, exp: Date.now() + 86400000 * 7 }));
const verifyToken = (token) => { try { const p = JSON.parse(atob(token)); return p.exp > Date.now() ? p : null; } catch { return null; } };

const Auth = {
  register: ({ email, password, firstName, lastName, company, gstin, plan, billingCycle }) => {
    if (DB.where('users', u => u.email === email.toLowerCase()).length) return { error: "Email already registered" };
    const org = DB.insert('orgs', { name: company, gstin: gstin || null, plan, billingCycle, subscriptionStatus: 'trial', trialEnds: new Date(Date.now() + 14*86400000).toISOString(), reportingYear: 'FY 2024-25', industry: 'Apparel & Textile', cin: '' });
    const user = DB.insert('users', { email: email.toLowerCase(), passwordHash: hash(password), firstName, lastName, orgId: org.id, role: 'admin', isActive: true, lastLogin: new Date().toISOString() });
    Auth._initOrgData(org.id, user.id);
    const token = signToken({ userId: user.id, orgId: org.id, role: user.role, email: user.email });
    DB.kv.set('session', token);
    return { token, user: { ...user, passwordHash: undefined }, org };
  },
  login: ({ email, password }) => {
    const user = DB.where('users', u => u.email === email.toLowerCase())[0];
    if (!user || user.passwordHash !== hash(password)) return { error: "Invalid email or password" };
    if (!user.isActive) return { error: "Account suspended. Contact support." };
    DB.update('users', user.id, { lastLogin: new Date().toISOString() });
    const org = DB.getOne('orgs', user.orgId);
    const token = signToken({ userId: user.id, orgId: user.orgId, role: user.role, email: user.email });
    DB.kv.set('session', token);
    Auth._audit(user.id, user.orgId, 'auth', 'User logged in', {});
    return { token, user: { ...user, passwordHash: undefined }, org };
  },
  logout: () => { localStorage.removeItem('siq_kv_session'); },
  session: () => { const t = DB.kv.get('session'); if (!t) return null; const p = verifyToken(t); if (!p) return null; const user = DB.getOne('users', p.userId); const org = DB.getOne('orgs', p.orgId); return user && org ? { user: { ...user, passwordHash: undefined }, org, token: t } : null; },
  forgotPassword: (email) => { const user = DB.where('users', u => u.email === email.toLowerCase())[0]; if (!user) return { error: "No account found" }; const code = Math.random().toString(36).slice(2, 8).toUpperCase(); DB.kv.set(`reset_${email}`, { code, exp: Date.now() + 900000 }); return { success: true, code }; },
  resetPassword: (email, code, newPassword) => { const stored = DB.kv.get(`reset_${email}`); if (!stored || stored.code !== code || stored.exp < Date.now()) return { error: "Invalid or expired code" }; const user = DB.where('users', u => u.email === email.toLowerCase())[0]; if (!user) return { error: "User not found" }; DB.update('users', user.id, { passwordHash: hash(newPassword) }); localStorage.removeItem(`siq_kv_reset_${email}`); return { success: true }; },
  _audit: (userId, orgId, type, action, meta) => DB.insert('audit_log', { userId, orgId, type, action, meta: JSON.stringify(meta), timestamp: new Date().toISOString() }),
  _initOrgData: (orgId, userId) => {
    const depts = [
      { name:"Environment & Facilities", icon:"🌿", ownerId: userId, ownerName:"You (Admin)", email:"", color:"#1a7a4a" },
      { name:"Human Resources",          icon:"👥", ownerId: null,   ownerName:"Unassigned",  email:"", color:"#2d4fd4" },
      { name:"Finance & Accounts",       icon:"💰", ownerId: null,   ownerName:"Unassigned",  email:"", color:"#7c3aed" },
      { name:"Procurement / SCM",        icon:"⛓",  ownerId: null,   ownerName:"Unassigned",  email:"", color:"#b45309" },
      { name:"Operations & EHS",         icon:"🏭", ownerId: null,   ownerName:"Unassigned",  email:"", color:"#c2410c" },
      { name:"Legal & Compliance",       icon:"⚖",  ownerId: null,   ownerName:"Unassigned",  email:"", color:"#374151" },
    ];
    depts.forEach(d => DB.insert('departments', { ...d, orgId }));
    const TASKS_TEMPLATE = [
      { title:"Scope 1 GHG Emissions",          dept:"Environment & Facilities", priority:"high",   fw:["BRSR","GRI","TCFD"], module:"emissions" },
      { title:"Scope 2 Electricity Consumption", dept:"Environment & Facilities", priority:"high",   fw:["BRSR","GRI","TCFD"], module:"emissions" },
      { title:"Water Withdrawal by Source",      dept:"Environment & Facilities", priority:"high",   fw:["BRSR","GRI"],        module:"water" },
      { title:"Waste Generation & Disposal",     dept:"Environment & Facilities", priority:"medium", fw:["BRSR","GRI","SASB"], module:"water" },
      { title:"Renewable Energy Certificates",   dept:"Environment & Facilities", priority:"medium", fw:["BRSR","GRI"],        module:"emissions" },
      { title:"Total Headcount by Gender",       dept:"Human Resources",          priority:"high",   fw:["BRSR","GRI"],        module:"social" },
      { title:"Pay Equity Analysis",             dept:"Human Resources",          priority:"high",   fw:["BRSR"],              module:"social" },
      { title:"Training Hours per Employee",     dept:"Human Resources",          priority:"medium", fw:["BRSR","GRI"],        module:"social" },
      { title:"Attrition Rate & Reasons",        dept:"Human Resources",          priority:"medium", fw:["BRSR"],              module:"social" },
      { title:"LTIFR & Safety Incidents",        dept:"Operations & EHS",         priority:"high",   fw:["BRSR","GRI","SASB"], module:"social" },
      { title:"CSR Spend & Project Details",     dept:"Finance & Accounts",       priority:"high",   fw:["BRSR"],              module:"governance" },
      { title:"Revenue & Financial Metrics",     dept:"Finance & Accounts",       priority:"medium", fw:["BRSR","SASB"],       module:"governance" },
      { title:"Business Travel Scope 3",         dept:"Finance & Accounts",       priority:"medium", fw:["BRSR","GRI","TCFD"], module:"emissions" },
      { title:"Supplier ESG Questionnaire",      dept:"Procurement / SCM",        priority:"high",   fw:["BRSR","GRI","SASB"], module:"supply" },
      { title:"Tier-2 Supplier Risk Assessment", dept:"Procurement / SCM",        priority:"medium", fw:["GRI","SASB"],        module:"supply" },
      { title:"Board Independence Charter",      dept:"Legal & Compliance",       priority:"high",   fw:["BRSR","TCFD"],       module:"governance" },
      { title:"Whistleblower Policy & Cases",    dept:"Legal & Compliance",       priority:"medium", fw:["BRSR","GRI"],        module:"governance" },
      { title:"Biodiversity Impact Assessment",  dept:"Environment & Facilities", priority:"low",    fw:["GRI"],               module:"water" },
    ];
    const due = new Date(Date.now() + 30*86400000).toISOString().split('T')[0];
    TASKS_TEMPLATE.forEach(t => DB.insert('tasks', { ...t, orgId, assigneeId: null, assigneeName: "Unassigned", status: "not_started", value: null, notes: "", due, fw: JSON.stringify(t.fw) }));
    DB.insert('esg_data', { orgId, module: 'emissions', data: JSON.stringify({}), updatedBy: userId });
    DB.insert('esg_data', { orgId, module: 'water',     data: JSON.stringify({}), updatedBy: userId });
    DB.insert('esg_data', { orgId, module: 'social',    data: JSON.stringify({}), updatedBy: userId });
    DB.insert('esg_data', { orgId, module: 'governance',data: JSON.stringify({}), updatedBy: userId });
    DB.insert('esg_data', { orgId, module: 'supply',    data: JSON.stringify({}), updatedBy: userId });
  }
};

/* ════════════════════════════════════════════════
   § 3  SUBSCRIPTION / BILLING SERVICE
════════════════════════════════════════════════ */
const PLANS_CONFIG = {
  starter:    { name:"Starter",    monthly:4999,  annual:49999,  features:["BRSR Core","GRI mapping","AI reports (10/mo)","Carbon+Water tracking","Data entry forms","Email support"], aiLimit:10 },
  growth:     { name:"Growth",     monthly:14999, annual:149999, features:["Everything in Starter","SASB+TCFD","Unlimited AI reports","Full workflow","Supply chain","Diversity analytics","Audit trail","Priority support","API access"], aiLimit:999 },
  enterprise: { name:"Enterprise", monthly:null,  annual:null,   features:["Everything in Growth","Unlimited entities","White-label","Custom mapping","Dedicated CSM","VAPT audit","SLA 99.9%"], aiLimit:999 },
};

const Billing = {
  processPayment: ({ orgId, userId, plan, billingCycle, paymentMethod, cardLast4 }) => {
    const cfg = PLANS_CONFIG[plan];
    const amount = billingCycle === 'annual' ? cfg.annual : cfg.monthly * 12;
    const gst = Math.round(amount * 0.18);
    const total = amount + gst;
    const orderId = 'SIQ-' + Math.random().toString(36).slice(2,8).toUpperCase();
    const inv = DB.insert('invoices', { orgId, userId, orderId, plan, billingCycle, amount, gst, total, paymentMethod, cardLast4: cardLast4 || null, status: 'paid', paidAt: new Date().toISOString(), nextBillingDate: new Date(Date.now() + (billingCycle==='annual'?365:30)*86400000).toISOString() });
    DB.update('orgs', orgId, { plan, billingCycle, subscriptionStatus: 'active', subscriptionStart: new Date().toISOString(), nextBillingDate: inv.nextBillingDate, aiReportsUsed: 0 });
    DB.insert('audit_log', { userId, orgId, type:'billing', action:`Subscription activated: ${cfg.name} (${billingCycle})`, meta: JSON.stringify({ orderId, total }), timestamp: new Date().toISOString() });
    return { success: true, orderId, invoice: inv };
  },
  cancelSubscription: (orgId, userId) => { DB.update('orgs', orgId, { subscriptionStatus: 'cancelled', cancelledAt: new Date().toISOString() }); DB.insert('audit_log', { userId, orgId, type:'billing', action:'Subscription cancelled', meta:'{}', timestamp: new Date().toISOString() }); return { success: true }; },
  getInvoices: (orgId) => DB.where('invoices', i => i.orgId === orgId).sort((a,b) => new Date(b.created_at) - new Date(a.created_at)),
  checkAiLimit: (org) => { const cfg = PLANS_CONFIG[org.plan] || PLANS_CONFIG.starter; return (org.aiReportsUsed || 0) < cfg.aiLimit; },
  incrementAiUsage: (orgId) => { const org = DB.getOne('orgs', orgId); DB.update('orgs', orgId, { aiReportsUsed: (org.aiReportsUsed || 0) + 1 }); },
};

/* ════════════════════════════════════════════════
   § 4  ESG DATA SERVICE
════════════════════════════════════════════════ */
const ESGService = {
  save: (orgId, userId, module, data) => {
    const existing = DB.where('esg_data', r => r.orgId === orgId && r.module === module)[0];
    const oldData = existing ? JSON.parse(existing.data || '{}') : {};
    if (existing) { DB.update('esg_data', existing.id, { data: JSON.stringify(data), updatedBy: userId }); }
    else { DB.insert('esg_data', { orgId, module, data: JSON.stringify(data), updatedBy: userId }); }
    const changes = Object.keys(data).filter(k => oldData[k] !== data[k]).map(k => `${k}: ${oldData[k]||'--'} -> ${data[k]}`).slice(0,5);
    if (changes.length) DB.insert('audit_log', { userId, orgId, type:'data_entry', action:`Updated ${module} data`, meta: JSON.stringify({ changes }), timestamp: new Date().toISOString() });
    ESGService._updateRelatedTasks(orgId, module);
    return { success: true };
  },
  get: (orgId, module) => { const r = DB.where('esg_data', r => r.orgId === orgId && r.module === module)[0]; return r ? JSON.parse(r.data || '{}') : {}; },
  getAll: (orgId) => { const modules = ['emissions','water','social','governance','supply']; const result = {}; modules.forEach(m => { result[m] = ESGService.get(orgId, m); }); return result; },
  getScore: (orgId) => { const all = ESGService.getAll(orgId); let filled = 0, total = 0; Object.values(all).forEach(d => { total += 10; filled += Math.min(10, Object.keys(d).filter(k=>d[k]).length); }); return Math.round((filled/total)*100) || 0; },
  _updateRelatedTasks: (orgId, module) => { const tasks = DB.where('tasks', t => t.orgId === orgId && t.module === module && t.status === 'not_started'); tasks.forEach(t => DB.update('tasks', t.id, { status: 'in_progress' })); },
};

/* ════════════════════════════════════════════════
   § 5  WORKFLOW SERVICE
════════════════════════════════════════════════ */
const WorkflowService = {
  getTasks: (orgId, filters={}) => {
    let tasks = DB.where('tasks', t => t.orgId === orgId);
    if (filters.dept) tasks = tasks.filter(t => t.dept === filters.dept);
    if (filters.status) tasks = tasks.filter(t => t.status === filters.status);
    if (filters.assignee) tasks = tasks.filter(t => t.assigneeId === filters.assignee);
    return tasks.map(t => ({ ...t, fw: typeof t.fw === 'string' ? JSON.parse(t.fw) : t.fw }));
  },
  updateTask: (orgId, userId, taskId, patch) => {
    const task = DB.getOne('tasks', taskId);
    if (!task || task.orgId !== orgId) return { error: "Not found" };
    const updated = DB.update('tasks', taskId, patch);
    DB.insert('audit_log', { userId, orgId, type:'workflow', action:`Task "${task.title}" -> ${patch.status || 'updated'}`, meta: JSON.stringify(patch), timestamp: new Date().toISOString() });
    if (patch.status === 'submitted') WorkflowService._notify(orgId, `${task.title} submitted for review`);
    return { success: true, task: { ...updated, fw: typeof updated.fw === 'string' ? JSON.parse(updated.fw) : updated.fw } };
  },
  assignTask: (orgId, userId, taskId, assigneeId, assigneeName) => {
    DB.update('tasks', taskId, { assigneeId, assigneeName });
    DB.insert('audit_log', { userId, orgId, type:'workflow', action:`Task assigned to ${assigneeName}`, meta: JSON.stringify({ taskId }), timestamp: new Date().toISOString() });
    WorkflowService._notify(orgId, `New task assigned to ${assigneeName}`);
    return { success: true };
  },
  getProgress: (orgId) => { const tasks = DB.where('tasks', t => t.orgId === orgId); const done = tasks.filter(t => t.status==='submitted'||t.status==='approved').length; return { total: tasks.length, done, pct: tasks.length ? Math.round(done/tasks.length*100) : 0 }; },
  _notify: (orgId, message) => DB.insert('notifications', { orgId, message, read: false, timestamp: new Date().toISOString() }),
};

/* ════════════════════════════════════════════════
   § 6  REPORTS SERVICE
════════════════════════════════════════════════ */
const ReportsService = {
  getHistory: (orgId) => DB.where('reports', r => r.orgId === orgId).sort((a,b) => new Date(b.created_at)-new Date(a.created_at)),
  save: (orgId, userId, fw, content, params) => DB.insert('reports', { orgId, userId, framework: fw, content, params: JSON.stringify(params), wordCount: content.split(' ').length }),
  delete: (orgId, reportId) => { const r = DB.getOne('reports', reportId); if (r?.orgId === orgId) DB.delete('reports', reportId); },
};

/* ════════════════════════════════════════════════
   § 7  USERS / TEAM SERVICE
════════════════════════════════════════════════ */
const TeamService = {
  getMembers: (orgId) => DB.where('users', u => u.orgId === orgId).map(u => ({ ...u, passwordHash: undefined })),
  inviteUser: (orgId, invitedBy, { email, firstName, lastName, role, dept }) => {
    if (DB.where('users', u => u.email === email.toLowerCase() && u.orgId === orgId).length) return { error: "Already a member" };
    const tempPass = Math.random().toString(36).slice(2, 10);
    const user = DB.insert('users', { email: email.toLowerCase(), passwordHash: hash(tempPass), firstName, lastName, orgId, role, dept, isActive: true, invitedBy, tempPassword: tempPass });
    DB.insert('audit_log', { userId: invitedBy, orgId, type:'team', action:`Invited ${email} as ${role}`, meta: JSON.stringify({ email, role }), timestamp: new Date().toISOString() });
    WorkflowService._notify(orgId, `${firstName} ${lastName} joined as ${role}`);
    return { success: true, user: { ...user, passwordHash: undefined }, tempPassword: tempPass };
  },
  updateRole: (orgId, userId, targetId, role) => { DB.update('users', targetId, { role }); DB.insert('audit_log', { userId, orgId, type:'team', action:`Changed role to ${role}`, meta: JSON.stringify({ targetId }), timestamp: new Date().toISOString() }); return { success: true }; },
  deactivate: (orgId, userId, targetId) => { DB.update('users', targetId, { isActive: false }); DB.insert('audit_log', { userId, orgId, type:'team', action:'User deactivated', meta: JSON.stringify({ targetId }), timestamp: new Date().toISOString() }); return { success: true }; },
};

/* ════════════════════════════════════════════════
   § 8  CONTEXT
════════════════════════════════════════════════ */
const AppCtx = createContext(null);
const useApp = () => useContext(AppCtx);

/* ════════════════════════════════════════════════
   § 9  STYLES
════════════════════════════════════════════════ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=DM+Serif+Display:ital@0;1&family=Azeret+Mono:wght@300;400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:#f7f6f2;color:#1c1b18;font-family:'Plus Jakarta Sans',sans-serif;overflow-x:hidden;font-size:14px}
:root{
  --bg:#f7f6f2;--bg2:#efede6;--bg3:#e6e3d8;
  --white:#ffffff;--ink:#1c1b18;--ink2:#3a3830;--ink3:#6b6a60;--ink4:#a09e94;
  --border:#dddad0;--border2:#c8c5b8;
  --green:#176639;--green-bg:#e6f4ec;--green-m:#a8dbc0;--green-dark:#0f4726;
  --orange:#c45208;--orange-bg:#fef0e6;--orange-m:#f9c49a;
  --blue:#1a3fa8;--blue-bg:#e8edfb;--blue-m:#a8baf5;
  --gold:#9a6f00;--gold-bg:#fdf5e0;--gold-m:#f0d080;
  --red:#b31b1b;--red-bg:#fdebeb;
  --violet:#5b21b6;--violet-bg:#f0eafe;
  --r:10px;--r-sm:6px;--r-lg:16px;--r-xl:24px;
  --shadow-xs:0 1px 2px rgba(0,0,0,0.05);
  --shadow-sm:0 2px 8px rgba(0,0,0,0.07);
  --shadow:0 6px 20px rgba(0,0,0,0.09);
  --shadow-lg:0 16px 48px rgba(0,0,0,0.12);
  --fw:600;
}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:var(--bg2)}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}

/* ── animations ── */
@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes checkPop{0%{transform:scale(0)}70%{transform:scale(1.15)}100%{transform:scale(1)}}
@keyframes slideDown{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
.fu{animation:fadeUp 0.35s ease forwards}
.fu1{animation-delay:0.05s;opacity:0}.fu2{animation-delay:0.1s;opacity:0}
.fu3{animation-delay:0.15s;opacity:0}.fu4{animation-delay:0.2s;opacity:0}

/* ── layout ── */
.shell{display:flex;min-height:100vh}
.sidebar{width:240px;background:var(--white);border-right:1px solid var(--border);
  display:flex;flex-direction:column;position:fixed;left:0;top:0;height:100vh;overflow-y:auto;z-index:100;flex-shrink:0}
.main-area{margin-left:240px;flex:1;display:flex;flex-direction:column;min-height:100vh}
.topbar{height:58px;background:var(--white);border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;padding:0 24px;
  position:sticky;top:0;z-index:50;gap:16px}
.page{padding:24px;flex:1;max-width:1400px;width:100%}

/* ── sidebar components ── */
.sb-logo{padding:18px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;cursor:pointer}
.sb-logo-mark{width:30px;height:30px;background:var(--ink);border-radius:7px;display:flex;align-items:center;justify-content:center;color:white;font-size:13px;font-weight:800;flex-shrink:0}
.sb-logo-text{font-size:16px;font-weight:800;letter-spacing:-0.4px}
.sb-logo-text em{font-style:normal;color:var(--green)}
.sb-logo-sub{font-size:9px;color:var(--ink4);font-family:'Azeret Mono',monospace;letter-spacing:1px;margin-top:1px;display:block}
.sb-section{font-size:9px;font-weight:700;color:var(--ink4);letter-spacing:2px;text-transform:uppercase;padding:14px 16px 5px;font-family:'Azeret Mono',monospace}
.sb-item{display:flex;align-items:center;gap:9px;padding:8px 12px;border-radius:var(--r-sm);cursor:pointer;
  transition:all 0.12s;font-size:13px;font-weight:500;color:var(--ink3);margin:1px 4px}
.sb-item:hover{background:var(--bg2);color:var(--ink)}
.sb-item.active{background:var(--ink);color:white}
.sb-item .ic{font-size:14px;width:20px;text-align:center;flex-shrink:0}
.sb-badge{margin-left:auto;font-size:9px;padding:1px 6px;border-radius:8px;font-family:'Azeret Mono',monospace;font-weight:700;background:var(--red-bg);color:var(--red)}
.sb-badge.ok{background:var(--green-bg);color:var(--green)}
.sb-score{margin:10px 12px;background:linear-gradient(135deg,var(--green-bg),var(--blue-bg));
  border:1px solid var(--green-m);border-radius:var(--r);padding:14px;text-align:center}
.sb-score-num{font-family:'DM Serif Display',serif;font-size:44px;font-weight:400;color:var(--ink);line-height:1}
.sb-score-label{font-size:9px;color:var(--ink3);font-family:'Azeret Mono',monospace;letter-spacing:1px;text-transform:uppercase}
.sb-score-bar{height:4px;background:var(--border);border-radius:2px;margin:8px 0 4px;overflow:hidden}
.sb-score-fill{height:100%;background:linear-gradient(90deg,var(--green),#34d07a);border-radius:2px;transition:width 0.6s}
.sb-user{padding:12px;border-top:1px solid var(--border);margin-top:auto;display:flex;align-items:center;gap:8px;cursor:pointer}
.sb-avatar{width:30px;height:30px;border-radius:50%;background:var(--ink);color:white;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.sb-user-name{font-size:12px;font-weight:700;line-height:1.2}
.sb-user-role{font-size:10px;color:var(--ink4);font-family:'Azeret Mono',monospace}
.sb-plan{font-size:9px;margin-left:auto;padding:2px 6px;border-radius:3px;font-family:'Azeret Mono',monospace;font-weight:700;background:var(--orange-bg);color:var(--orange)}

/* ── topbar ── */
.tb-title{font-size:16px;font-weight:700;letter-spacing:-0.3px}
.tb-sub{font-size:11px;color:var(--ink4);font-family:'Azeret Mono',monospace}
.tb-right{display:flex;align-items:center;gap:8px}
.tb-notif{position:relative;cursor:pointer;padding:6px;border-radius:var(--r-sm);transition:background 0.12s}
.tb-notif:hover{background:var(--bg2)}
.tb-notif-dot{position:absolute;top:4px;right:4px;width:7px;height:7px;background:var(--red);border-radius:50%;border:1px solid white}
.plan-chip{padding:4px 10px;border-radius:var(--r-sm);font-size:10px;font-weight:700;font-family:'Azeret Mono',monospace;background:var(--orange-bg);color:var(--orange);border:1px solid var(--orange-m)}
.plan-chip.active{background:var(--green-bg);color:var(--green);border-color:var(--green-m)}

/* ── buttons ── */
.btn{padding:8px 18px;border-radius:var(--r-sm);font-size:13px;font-weight:700;cursor:pointer;
  border:none;transition:all 0.14s;font-family:'Plus Jakarta Sans',sans-serif;
  display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.btn-ink{background:var(--ink);color:white}.btn-ink:hover{background:var(--ink2);transform:translateY(-1px);box-shadow:var(--shadow-sm)}
.btn-green{background:var(--green);color:white}.btn-green:hover{background:var(--green-dark);transform:translateY(-1px)}
.btn-orange{background:var(--orange);color:white}.btn-orange:hover{background:#a8440a}
.btn-outline{background:var(--white);color:var(--ink);border:1.5px solid var(--border2)}.btn-outline:hover{border-color:var(--ink)}
.btn-ghost{background:transparent;color:var(--ink3)}.btn-ghost:hover{background:var(--bg2);color:var(--ink)}
.btn-red{background:var(--red);color:white}
.btn-sm{padding:6px 14px;font-size:12px}
.btn-lg{padding:11px 24px;font-size:14px;border-radius:var(--r)}
.btn-xl{padding:14px 32px;font-size:15px;border-radius:var(--r)}
.btn:disabled{opacity:0.45;cursor:not-allowed;transform:none !important}
.btn-loading::after{content:'';display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,0.35);border-top-color:white;border-radius:50%;animation:spin 0.7s linear infinite;margin-left:4px}

/* ── cards ── */
.card{background:var(--white);border:1px solid var(--border);border-radius:var(--r);padding:20px}
.card-lg{background:var(--white);border:1px solid var(--border);border-radius:var(--r-lg);padding:26px}
.card-xl{background:var(--white);border:1px solid var(--border);border-radius:var(--r-xl);padding:32px}
.card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.card-title{font-size:14px;font-weight:700;letter-spacing:-0.2px}
.card-sub{font-size:12px;color:var(--ink3);margin-top:2px}

/* ── kpi grid ── */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:20px}
.kpi{background:var(--white);border:1px solid var(--border);border-radius:var(--r);padding:16px;
  position:relative;overflow:hidden;cursor:pointer;transition:all 0.15s}
.kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--kc,var(--green))}
.kpi:hover{box-shadow:var(--shadow-sm);transform:translateY(-1px)}
.kpi-icon{font-size:18px;margin-bottom:8px}
.kpi-label{font-size:9px;color:var(--ink3);letter-spacing:1.5px;text-transform:uppercase;font-family:'Azeret Mono',monospace;margin-bottom:4px}
.kpi-val{font-family:'DM Serif Display',serif;font-size:24px;font-weight:400;line-height:1}
.kpi-unit{font-size:10px;color:var(--ink4);margin-left:2px;font-family:'Azeret Mono',monospace}
.kpi-trend{font-size:10px;margin-top:5px;font-family:'Azeret Mono',monospace}
.t-good{color:var(--green)}.t-bad{color:var(--red)}.t-neutral{color:var(--ink4)}

/* ── table ── */
.tbl-wrap{background:var(--white);border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden;margin-bottom:20px}
.tbl-toolbar{padding:14px 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:10px}
.tbl-title{font-size:14px;font-weight:700}
table{width:100%;border-collapse:collapse}
thead th{padding:9px 18px;text-align:left;font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:1.5px;font-family:'Azeret Mono',monospace;border-bottom:1px solid var(--border);background:var(--bg);font-weight:600}
tbody td{padding:11px 18px;font-size:13px;border-bottom:1px solid rgba(221,218,208,0.4)}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:var(--bg)}
.pill{padding:2px 8px;border-radius:10px;font-size:9px;font-weight:700;font-family:'Azeret Mono',monospace;display:inline-block;letter-spacing:0.3px}
.p-green{background:var(--green-bg);color:var(--green)}
.p-amber{background:var(--gold-bg);color:var(--gold)}
.p-red{background:var(--red-bg);color:var(--red)}
.p-blue{background:var(--blue-bg);color:var(--blue)}
.p-violet{background:var(--violet-bg);color:var(--violet)}
.p-ink{background:var(--bg3);color:var(--ink3)}
.p-orange{background:var(--orange-bg);color:var(--orange)}

/* ── forms ── */
.field{display:flex;flex-direction:column;gap:5px;margin-bottom:14px}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.field-row-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.field label{font-size:11px;font-weight:700;color:var(--ink2)}
.field .hint{font-size:10px;color:var(--ink4);font-family:'Azeret Mono',monospace;margin-top:2px}
.field .err-msg{font-size:10px;color:var(--red);font-family:'Azeret Mono',monospace;margin-top:2px}
input[type=text],input[type=email],input[type=password],input[type=tel],input[type=number],input[type=date],select,textarea{
  width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:var(--r-sm);
  font-size:13px;font-family:'Plus Jakarta Sans',sans-serif;color:var(--ink);background:var(--white);
  outline:none;transition:all 0.13s;appearance:none}
input:focus,select:focus,textarea:focus{border-color:var(--ink);box-shadow:0 0 0 3px rgba(28,27,24,0.06)}
input.ok{border-color:var(--green);background:#fbfefb}
input.bad{border-color:var(--red);background:var(--red-bg)}
textarea{resize:vertical;min-height:80px;line-height:1.55}
.input-unit{display:flex}
.input-unit input{border-radius:var(--r-sm) 0 0 var(--r-sm);border-right:none;flex:1}
.unit{padding:9px 10px;background:var(--bg3);border:1.5px solid var(--border);border-left:none;border-radius:0 var(--r-sm) var(--r-sm) 0;font-size:11px;font-family:'Azeret Mono',monospace;color:var(--ink3);white-space:nowrap;display:flex;align-items:center}
.search-box{padding:7px 12px;border:1.5px solid var(--border);border-radius:var(--r-sm);font-size:12px;font-family:'Plus Jakarta Sans',sans-serif;background:var(--bg);color:var(--ink);outline:none;min-width:180px;transition:border-color 0.13s}
.search-box:focus{border-color:var(--ink)}
.fsel{padding:7px 12px;border:1.5px solid var(--border);border-radius:var(--r-sm);font-size:12px;font-family:'Plus Jakarta Sans',sans-serif;background:var(--bg);color:var(--ink);outline:none;cursor:pointer}
.cb-row{display:flex;align-items:flex-start;gap:8px;margin-bottom:10px}
.cb-row input[type=checkbox]{width:15px;height:15px;flex-shrink:0;margin-top:1px;accent-color:var(--ink);cursor:pointer}
.cb-label{font-size:12px;color:var(--ink3);line-height:1.5}
.cb-label a{color:var(--blue);cursor:pointer;text-decoration:underline}

/* ── misc ui ── */
.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.section-title{font-size:16px;font-weight:700;letter-spacing:-0.3px}
.divider{height:1px;background:var(--border);margin:18px 0}
.tag{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:4px;
  font-size:9px;font-weight:700;font-family:'Azeret Mono',monospace;letter-spacing:0.5px}
.t-brsr{background:#fff3ed;color:#c2410c;border:1px solid #fcd9c5}
.t-gri{background:var(--green-bg);color:var(--green);border:1px solid var(--green-m)}
.t-sasb{background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-m)}
.t-tcfd{background:var(--gold-bg);color:var(--gold);border:1px solid var(--gold-m)}
.empty{text-align:center;padding:48px 24px;color:var(--ink4)}
.empty-icon{font-size:36px;margin-bottom:12px}
.empty p{font-size:13px;margin-top:6px}
.progress-bar{height:5px;background:var(--border);border-radius:3px;overflow:hidden}
.progress-fill{height:100%;border-radius:3px;transition:width 0.5s ease}
.bar-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.bar-label{font-size:11px;width:90px;flex-shrink:0;color:var(--ink3)}
.bar-pct{font-size:10px;font-family:'Azeret Mono',monospace;color:var(--ink4);width:30px;text-align:right}
.avatar{width:28px;height:28px;border-radius:50%;background:var(--ink);color:white;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}

/* ── landing page ── */
.landing{background:var(--white)}
.lnav{position:fixed;top:0;left:0;right:0;z-index:500;height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 5vw;transition:all 0.2s}
.lnav.scrolled{background:rgba(255,255,255,0.92);backdrop-filter:blur(16px);border-bottom:1px solid var(--border);box-shadow:var(--shadow-xs)}
.hero{min-height:100vh;display:flex;align-items:center;padding:90px 5vw 60px;position:relative;overflow:hidden;background:var(--white)}
.hero-bg{position:absolute;inset:0;background:radial-gradient(ellipse 70% 50% at 70% 30%,rgba(23,102,57,0.05),transparent 60%),radial-gradient(ellipse 50% 50% at 20% 80%,rgba(196,82,8,0.04),transparent 60%);pointer-events:none}
.hero-grid{position:absolute;inset:0;background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);background-size:64px 64px;opacity:0.3;mask-image:radial-gradient(ellipse 80% 80% at 50% 50%,black,transparent);pointer-events:none}
.hero-inner{max-width:1100px;margin:0 auto;width:100%;display:grid;grid-template-columns:1fr 1fr;gap:60px;align-items:center}
.hero-tag{display:inline-flex;align-items:center;gap:7px;padding:6px 14px;background:var(--orange-bg);border:1px solid var(--orange-m);border-radius:30px;font-size:11px;font-weight:700;color:var(--orange);margin-bottom:24px;font-family:'Azeret Mono',monospace;letter-spacing:0.3px}
.hero-tag-dot{width:6px;height:6px;background:var(--orange);border-radius:50%;animation:pulse 2s infinite}
.hero-h1{font-family:'DM Serif Display',serif;font-size:clamp(44px,5.5vw,72px);font-weight:400;line-height:1.05;letter-spacing:-1px;margin-bottom:22px;color:var(--ink)}
.hero-h1 em{color:var(--green)}
.hero-sub{font-size:16px;color:var(--ink3);line-height:1.65;margin-bottom:32px;max-width:480px}
.hero-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:28px}
.hero-note{font-size:11px;color:var(--ink4);font-family:'Azeret Mono',monospace}
.hero-card{background:var(--white);border:1px solid var(--border);border-radius:var(--r-xl);padding:22px;box-shadow:var(--shadow-lg);animation:fadeIn 0.6s ease 0.3s both}
.hc-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.hc-live{display:flex;align-items:center;gap:6px;font-size:10px;font-family:'Azeret Mono',monospace;color:var(--green);font-weight:700}
.hc-live-dot{width:6px;height:6px;background:var(--green);border-radius:50%;animation:pulse 1.5s infinite}
.hc-metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px}
.hc-metric{background:var(--bg);border-radius:var(--r-sm);padding:10px 12px}
.hc-val{font-family:'DM Serif Display',serif;font-size:20px;font-weight:400;line-height:1;margin-bottom:2px}
.hc-lbl{font-size:9px;color:var(--ink4);font-family:'Azeret Mono',monospace;letter-spacing:0.5px}
.hc-trend{font-size:9px;font-family:'Azeret Mono',monospace;margin-top:3px}
.stats-strip{display:flex;border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden;margin-bottom:56px;max-width:600px}
.stat-strip-item{flex:1;padding:20px 16px;text-align:center;border-right:1px solid var(--border)}
.stat-strip-item:last-child{border-right:none}
.stat-strip-val{font-family:'DM Serif Display',serif;font-size:28px;font-weight:400;color:var(--ink)}
.stat-strip-lbl{font-size:10px;color:var(--ink3);font-family:'Azeret Mono',monospace;margin-top:3px;letter-spacing:0.5px}
.section{padding:80px 5vw}
.sec-inner{max-width:1100px;margin:0 auto}
.sec-eyebrow{font-size:10px;font-weight:700;color:var(--green);letter-spacing:3px;text-transform:uppercase;font-family:'Azeret Mono',monospace;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.sec-eyebrow::before{content:'';width:20px;height:2px;background:var(--green);border-radius:1px}
.sec-h2{font-family:'DM Serif Display',serif;font-size:clamp(30px,3.5vw,48px);font-weight:400;letter-spacing:-0.5px;line-height:1.1;margin-bottom:16px}
.sec-h2 em{color:var(--green)}
.sec-p{font-size:15px;color:var(--ink3);line-height:1.65;max-width:520px;margin-bottom:48px}
.features-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.feat-card{background:var(--white);border:1px solid var(--border);border-radius:var(--r-lg);padding:26px;transition:all 0.15s;position:relative;overflow:hidden}
.feat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--fc,var(--green));opacity:0.7}
.feat-card:hover{box-shadow:var(--shadow);transform:translateY(-2px)}
.feat-icon{font-size:26px;margin-bottom:14px}
.feat-title{font-size:15px;font-weight:700;margin-bottom:8px;letter-spacing:-0.2px}
.feat-desc{font-size:13px;color:var(--ink3);line-height:1.6}
.pricing-toggle{display:flex;background:var(--bg2);border-radius:30px;padding:4px;width:fit-content;margin-bottom:36px}
.pt-opt{padding:7px 20px;border-radius:30px;font-size:13px;font-weight:700;cursor:pointer;transition:all 0.13s;color:var(--ink3);border:none;background:none;font-family:'Plus Jakarta Sans',sans-serif}
.pt-opt.active{background:var(--white);color:var(--ink);box-shadow:var(--shadow-xs)}
.save-tag{background:var(--green);color:white;font-size:9px;font-weight:700;padding:1px 7px;border-radius:8px;font-family:'Azeret Mono',monospace;margin-left:4px}
.pricing-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;max-width:920px}
.pc{background:var(--white);border:1px solid var(--border);border-radius:var(--r-xl);padding:30px;transition:all 0.15s;position:relative}
.pc.featured{background:var(--ink);color:white;border-color:var(--ink);box-shadow:var(--shadow-lg);transform:scale(1.02)}
.pc:not(.featured):hover{box-shadow:var(--shadow);transform:translateY(-2px)}
.pc-pop{position:absolute;top:16px;right:16px;background:var(--orange);color:white;font-size:8px;font-weight:700;padding:2px 8px;border-radius:10px;font-family:'Azeret Mono',monospace}
.pc-plan{font-size:10px;font-weight:700;letter-spacing:2px;font-family:'Azeret Mono',monospace;text-transform:uppercase;margin-bottom:8px;color:var(--ink3)}
.pc.featured .pc-plan{color:rgba(255,255,255,0.5)}
.pc-price{font-family:'DM Serif Display',serif;font-size:40px;font-weight:400;letter-spacing:-1px;line-height:1;margin-bottom:4px}
.pc-cur{font-size:18px;vertical-align:top;margin-top:5px;display:inline-block;font-family:'Plus Jakarta Sans',sans-serif}
.pc-period{font-size:12px;color:var(--ink3);margin-bottom:8px}
.pc.featured .pc-period{color:rgba(255,255,255,0.5)}
.pc-tag{font-size:13px;color:var(--ink3);margin-bottom:20px;min-height:38px;line-height:1.5}
.pc.featured .pc-tag{color:rgba(255,255,255,0.6)}
.pc-div{height:1px;background:var(--border);margin:0 0 16px}
.pc.featured .pc-div{background:rgba(255,255,255,0.12)}
.pc-feats{list-style:none;display:flex;flex-direction:column;gap:8px;margin-bottom:24px}
.pc-feats li{font-size:13px;display:flex;gap:7px;align-items:flex-start}
.pc-feats li .ck{color:var(--green);font-weight:700;flex-shrink:0;margin-top:1px}
.pc.featured .pc-feats li{color:rgba(255,255,255,0.82)}
.pc.featured .pc-feats li .ck{color:#4ade80}
.pc-feats li.dim{color:var(--ink4)}.pc-feats li.dim .ck{color:var(--ink4)}
.testimonial-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.tc{background:var(--white);border:1px solid var(--border);border-radius:var(--r-lg);padding:24px;transition:all 0.15s}
.tc:hover{box-shadow:var(--shadow);transform:translateY(-2px)}
.tc-stars{color:#f59e0b;font-size:11px;letter-spacing:2px;margin-bottom:10px}
.tc-text{font-family:'DM Serif Display',serif;font-style:italic;font-size:15px;color:var(--ink2);line-height:1.6;margin-bottom:16px}
.tc-author{display:flex;align-items:center;gap:10px}
.tc-name{font-size:13px;font-weight:700}.tc-role{font-size:10px;color:var(--ink3);font-family:'Azeret Mono',monospace}
.faq-list{display:flex;flex-direction:column;gap:8px;max-width:800px}
.faq-item{background:var(--white);border:1px solid var(--border);border-radius:var(--r);padding:18px 20px;cursor:pointer;transition:all 0.13s}
.faq-item:hover{border-color:var(--border2)}
.faq-item.open{border-color:var(--green);background:var(--green-bg)}
.faq-q{font-size:14px;font-weight:700;display:flex;justify-content:space-between;align-items:center;gap:10px}
.faq-toggle{font-size:18px;color:var(--ink3);flex-shrink:0;transition:transform 0.18s}
.faq-item.open .faq-toggle{transform:rotate(45deg);color:var(--green)}
.faq-a{font-size:13px;color:var(--ink3);line-height:1.65;margin-top:10px;display:none}
.faq-item.open .faq-a{display:block}
.cta-banner{background:var(--ink);padding:72px 5vw;text-align:center}
.footer{background:var(--ink);border-top:1px solid rgba(255,255,255,0.06);padding:56px 5vw 28px;color:rgba(255,255,255,0.6)}
.footer-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:40px;margin-bottom:40px}
.footer-col-title{font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;font-family:'Azeret Mono',monospace;color:rgba(255,255,255,0.35);margin-bottom:14px}
.footer-links{list-style:none;display:flex;flex-direction:column;gap:8px}
.footer-links li{font-size:13px;cursor:pointer;transition:color 0.12s}
.footer-links li:hover{color:white}
.footer-bottom{border-top:1px solid rgba(255,255,255,0.06);padding-top:20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
.footer-copy{font-size:11px;color:rgba(255,255,255,0.3);font-family:'Azeret Mono',monospace}

/* ── auth pages ── */
.auth-shell{min-height:100vh;display:grid;grid-template-columns:1fr 1fr}
.auth-left{background:var(--ink);display:flex;flex-direction:column;justify-content:center;padding:60px;position:relative;overflow:hidden}
.auth-left-bg{position:absolute;inset:0;background:radial-gradient(ellipse 60% 60% at 20% 30%,rgba(23,102,57,0.3),transparent 60%),radial-gradient(ellipse 50% 50% at 80% 70%,rgba(196,82,8,0.2),transparent 60%)}
.auth-left-content{position:relative;z-index:1}
.auth-right{display:flex;flex-direction:column;justify-content:center;padding:60px;background:var(--white)}
.auth-form-title{font-family:'DM Serif Display',serif;font-size:28px;font-weight:400;margin-bottom:6px;color:var(--ink)}
.auth-form-sub{font-size:13px;color:var(--ink3);margin-bottom:28px;line-height:1.5}

/* ── checkout ── */
.checkout-shell{min-height:100vh;background:var(--bg);display:flex;flex-direction:column}
.checkout-nav{height:58px;background:var(--white);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 5vw}
.checkout-steps{display:flex;align-items:center;gap:6px}
.cs{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--ink4)}
.cs.active{color:var(--ink);font-weight:700}
.cs.done{color:var(--green)}
.cs-num{width:26px;height:26px;border-radius:50%;border:2px solid currentColor;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}
.cs.done .cs-num{background:var(--green);border-color:var(--green);color:white}
.cs.active .cs-num{background:var(--ink);border-color:var(--ink);color:white}
.cs-sep{width:32px;height:1px;background:var(--border);margin:0 2px}
.cs-sep.done{background:var(--green)}
.checkout-body{flex:1;padding:32px 5vw;display:flex;justify-content:center}
.checkout-layout{display:grid;grid-template-columns:1fr 360px;gap:28px;max-width:960px;width:100%;align-items:start}
.order-summary{background:var(--white);border:1px solid var(--border);border-radius:var(--r-xl);padding:24px;position:sticky;top:20px}
.os-plan-row{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.os-plan-name{font-size:16px;font-weight:800;letter-spacing:-0.3px}
.os-plan-period{font-size:10px;color:var(--ink4);font-family:'Azeret Mono',monospace;margin-top:3px}
.os-price-val{font-family:'DM Serif Display',serif;font-size:26px}
.os-price-mo{font-size:10px;color:var(--ink4);font-family:'Azeret Mono',monospace}
.os-feats{list-style:none;display:flex;flex-direction:column;gap:7px;margin-bottom:16px}
.os-feats li{font-size:12px;display:flex;gap:7px;align-items:center}
.os-feats li::before{content:'✓';color:var(--green);font-weight:700;font-size:11px;flex-shrink:0}
.os-total{border-top:1px solid var(--border);padding-top:14px}
.os-row{display:flex;justify-content:space-between;font-size:12px;color:var(--ink3);margin-bottom:7px}
.os-final{display:flex;justify-content:space-between;font-size:15px;font-weight:800;margin-top:4px}
.os-secure{text-align:center;font-size:10px;color:var(--ink4);font-family:'Azeret Mono',monospace;margin-top:14px;display:flex;align-items:center;justify-content:center;gap:5px}
.os-change{text-align:center;margin-top:10px;font-size:11px;color:var(--blue);cursor:pointer;font-weight:700}
.os-change:hover{text-decoration:underline}
.guarantee-box{margin-top:14px;padding:12px;background:var(--green-bg);border:1px solid var(--green-m);border-radius:var(--r-sm)}
.pay-method-tabs{display:flex;gap:8px;margin-bottom:18px}
.pm-tab{flex:1;padding:10px;border:1.5px solid var(--border);border-radius:var(--r-sm);cursor:pointer;text-align:center;font-size:12px;font-weight:700;transition:all 0.12s;background:var(--white);font-family:'Plus Jakarta Sans',sans-serif}
.pm-tab.active{border-color:var(--ink);background:var(--ink);color:white}
.pm-tab-icon{font-size:18px;display:block;margin-bottom:3px}
.card-wrap{border:1.5px solid var(--border);border-radius:var(--r-sm);overflow:hidden;transition:border-color 0.13s}
.card-wrap:focus-within{border-color:var(--ink);box-shadow:0 0 0 3px rgba(28,27,24,0.06)}
.card-num-row{display:flex;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border);gap:7px}
.card-brand{font-size:10px;font-family:'Azeret Mono',monospace;padding:2px 6px;background:var(--bg2);border-radius:3px;font-weight:700;color:var(--ink3)}
.card-num-input{flex:1;border:none;outline:none;font-size:13px;font-family:'Azeret Mono',monospace;background:transparent;color:var(--ink)}
.card-r2{display:flex}
.card-exp,.card-cvv{flex:1;padding:10px 12px;border:none;outline:none;font-size:13px;font-family:'Azeret Mono',monospace;background:transparent;color:var(--ink)}
.card-exp{border-right:1px solid var(--border)}
.upi-providers{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px}
.upi-opt{padding:7px 13px;border:1.5px solid var(--border);border-radius:var(--r-sm);font-size:11px;font-weight:700;cursor:pointer;transition:all 0.12s;font-family:'Azeret Mono',monospace}
.upi-opt.sel{border-color:var(--green);background:var(--green-bg);color:var(--green)}
.nb-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
.nb-opt{padding:9px;border:1.5px solid var(--border);border-radius:var(--r-sm);font-size:11px;font-weight:700;cursor:pointer;transition:all 0.12s;text-align:center}
.nb-opt.sel{border-color:var(--green);background:var(--green-bg);color:var(--green)}
.pw-wrap{position:relative}
.pw-wrap input{padding-right:40px}
.pw-eye{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:15px;color:var(--ink3);padding:3px}
.success-screen{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px;text-align:center;background:linear-gradient(160deg,var(--green-bg) 0%,var(--white) 50%)}
.success-ring{width:74px;height:74px;background:var(--green);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px;margin:0 auto 24px;animation:checkPop 0.4s ease 0.2s both;box-shadow:0 0 0 14px var(--green-m)}
.success-plan-box{background:var(--white);border:1px solid var(--border);border-radius:var(--r-xl);padding:22px 28px;margin-bottom:24px;min-width:300px;text-align:left;box-shadow:var(--shadow)}
.spb-row{display:flex;justify-content:space-between;margin-bottom:7px;font-size:13px}
.next-steps{text-align:left;margin-bottom:28px;max-width:380px}
.next-step{display:flex;gap:10px;align-items:flex-start;margin-bottom:10px;font-size:13px;color:var(--ink3)}
.next-step-num{width:22px;height:22px;background:var(--green);border-radius:50%;color:white;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}

/* ── dashboard ── */
.chart-row{display:grid;grid-template-columns:3fr 2fr;gap:12px;margin-bottom:20px}
.mini-chart{width:100%;height:120px}

/* ── reports ── */
.fw-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px}
.fw-opt{border:1.5px solid var(--border);border-radius:var(--r);padding:14px;cursor:pointer;transition:all 0.13s;background:var(--white);position:relative;overflow:hidden}
.fw-opt::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--fo-c,var(--green));opacity:0;transition:opacity 0.13s}
.fw-opt:hover::before,.fw-opt.sel::before{opacity:1}
.fw-opt.sel{border-color:var(--fo-c,var(--green));background:var(--fo-bg,var(--green-bg))}
.fw-opt-id{font-family:'DM Serif Display',serif;font-size:20px;font-weight:400;margin-bottom:4px}
.fw-opt-name{font-size:10px;color:var(--ink3);font-family:'Azeret Mono',monospace;margin-bottom:5px;line-height:1.3}
.fw-opt-desc{font-size:11px;color:var(--ink4);line-height:1.4}
.new-tag{position:absolute;top:8px;right:8px;background:var(--orange);color:white;font-size:7px;font-weight:700;padding:2px 6px;border-radius:3px;font-family:'Azeret Mono',monospace}
.ai-output-box{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r-lg);padding:22px;margin-top:16px;position:relative}
.ai-output-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border)}
.ai-tag{display:flex;align-items:center;gap:7px;font-size:10px;font-family:'Azeret Mono',monospace;color:var(--green);font-weight:700}
.ai-dot{width:6px;height:6px;background:var(--green);border-radius:50%;animation:pulse 1.5s infinite}
.ai-text{font-family:'Azeret Mono',monospace;font-size:12px;color:var(--ink2);white-space:pre-wrap;line-height:1.75;max-height:400px;overflow-y:auto}
.spinner{display:flex;align-items:center;gap:10px;padding:10px 0}
.spin-d span{display:inline-block;width:7px;height:7px;border-radius:50%;margin:0 2px;animation:spinBounce 1.2s infinite}
.spin-d span:nth-child(1){background:var(--green)}
.spin-d span:nth-child(2){background:var(--blue);animation-delay:.15s}
.spin-d span:nth-child(3){background:var(--orange);animation-delay:.3s}
@keyframes spinBounce{0%,80%,100%{transform:scale(0.6);opacity:0.4}40%{transform:scale(1);opacity:1}}
.report-hist-item{background:var(--white);border:1px solid var(--border);border-radius:var(--r);padding:14px 18px;display:flex;align-items:center;gap:14px;margin-bottom:8px;cursor:pointer;transition:all 0.12s}
.report-hist-item:hover{box-shadow:var(--shadow-xs);border-color:var(--border2)}

/* ── settings ── */
.settings-layout{display:grid;grid-template-columns:200px 1fr;gap:20px}
.settings-nav{background:var(--white);border:1px solid var(--border);border-radius:var(--r-lg);padding:8px;height:fit-content;position:sticky;top:20px}
.settings-nav-item{padding:8px 12px;border-radius:var(--r-sm);cursor:pointer;font-size:13px;font-weight:500;color:var(--ink3);transition:all 0.12s;display:flex;align-items:center;gap:8px}
.settings-nav-item:hover{background:var(--bg2);color:var(--ink)}
.settings-nav-item.active{background:var(--ink);color:white}

/* ── notifications panel ── */
.notif-panel{position:fixed;top:58px;right:0;width:360px;background:var(--white);border-left:1px solid var(--border);height:calc(100vh - 58px);z-index:300;box-shadow:var(--shadow-lg);display:flex;flex-direction:column;animation:slideDown 0.2s ease}
.notif-header{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.notif-list-wrap{flex:1;overflow-y:auto;padding:12px}
.notif-item{padding:12px 14px;border-radius:var(--r);cursor:pointer;border:1px solid transparent;transition:all 0.12s;margin-bottom:6px;display:flex;gap:10px}
.notif-item.unread{background:var(--blue-bg);border-color:rgba(26,63,168,0.12)}
.notif-item:hover{background:var(--bg2)}
.notif-icon{font-size:18px;flex-shrink:0;margin-top:1px}
.notif-body .notif-title{font-size:13px;font-weight:700;margin-bottom:3px}
.notif-body .notif-desc{font-size:11.5px;color:var(--ink3);line-height:1.5}
.notif-body .notif-time{font-size:10px;color:var(--ink4);font-family:'Azeret Mono',monospace;margin-top:4px}

/* ── audit trail ── */
.audit-item{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--bg2);position:relative}
.audit-line{position:absolute;left:16px;top:40px;bottom:-12px;width:1px;background:var(--border)}
.audit-avatar{width:32px;height:32px;border-radius:50%;background:var(--ink);color:white;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;z-index:1}
.audit-body .audit-action{font-size:13px;font-weight:500;line-height:1.4;margin-bottom:2px}
.audit-meta{font-size:10px;color:var(--ink4);font-family:'Azeret Mono',monospace;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.audit-change{background:var(--green-bg);border:1px solid var(--green-m);border-radius:3px;padding:1px 6px;font-size:10px;font-family:'Azeret Mono',monospace;color:var(--green)}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(3px);animation:fadeIn 0.2s ease}
.modal{background:var(--white);border-radius:var(--r-xl);width:100%;max-width:520px;max-height:88vh;overflow-y:auto;box-shadow:var(--shadow-lg);animation:fadeUp 0.25s ease}
.modal-head{padding:22px 26px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.modal-head h2{font-family:'DM Serif Display',serif;font-size:20px;font-weight:400}
.modal-body{padding:20px 26px}
.modal-foot{padding:14px 26px 20px;display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--border)}
.modal-close{background:none;border:none;font-size:20px;cursor:pointer;color:var(--ink3);padding:2px 6px;border-radius:4px;transition:background 0.12s;line-height:1}
.modal-close:hover{background:var(--bg2)}
.toast-root{position:fixed;bottom:20px;right:20px;z-index:2000;display:flex;flex-direction:column;gap:7px}
.toast{background:var(--ink);color:white;padding:11px 16px;border-radius:var(--r);font-size:13px;font-weight:600;box-shadow:var(--shadow-lg);display:flex;align-items:center;gap:8px;animation:slideDown 0.22s ease;max-width:320px}
.toast.ok{background:var(--green)}.toast.warn{background:var(--gold)}.toast.err{background:var(--red)}
.banner{padding:8px 24px;background:var(--orange-bg);border-bottom:1px solid var(--orange-m);font-size:12px;color:var(--orange);font-weight:600;display:flex;align-items:center;justify-content:space-between;gap:12px}
`;

/* ════════════════════════════════════════════════
   § 10  TINY COMPONENTS
════════════════════════════════════════════════ */
function Toast({ toasts }) {
  return <div className="toast-root">{toasts.map(t => <div key={t.id} className={`toast ${t.type||''}`}>{t.icon||'✓'} {t.msg}</div>)}</div>;
}
function Modal({ open, onClose, title, children, footer }) {
  if (!open) return null;
  return <div className="modal-overlay" onClick={e => e.target===e.currentTarget&&onClose()}>
    <div className="modal">
      <div className="modal-head"><h2>{title}</h2><button className="modal-close" onClick={onClose}>x</button></div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </div>
  </div>;
}
function Pill({ label, color="ink" }) { return <span className={`pill p-${color}`}>{label}</span>; }
function Tag({ fw }) { return <span className={`tag t-${fw.toLowerCase()}`}>{fw}</span>; }
function Avatar({ name, size=28 }) {
  const ini = name ? name.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase() : '?';
  return <div className="avatar" style={{width:size,height:size,fontSize:size*0.38}}>{ini}</div>;
}

function LineChart({ data, k1, k2, c1="#176639", c2="#1a3fa8" }) {
  const W=500,H=100,P=24;
  if (!data?.length) return <div style={{height:100,display:'flex',alignItems:'center',justifyContent:'center',color:'var(--ink4)',fontSize:12}}>No data yet</div>;
  const v1=data.map(d=>d[k1]||0), v2=k2?data.map(d=>d[k2]||0):[];
  const all=[...v1,...v2], mx=Math.max(...all,1), mn=Math.min(...all,0);
  const px=i=>P+(i/(data.length-1||1))*(W-2*P);
  const py=v=>P+((mx-v)/(mx-mn||1))*(H-2*P);
  const line=vs=>vs.map((v,i)=>`${i===0?'M':'L'}${px(i)},${py(v)}`).join(' ');
  const area=vs=>line(vs)+` L${px(vs.length-1)},${H-P} L${P},${H-P} Z`;
  return <svg viewBox={`0 0 ${W} ${H}`} className="mini-chart">
    {[0,.5,1].map(t=><line key={t} x1={P} y1={P+t*(H-2*P)} x2={W-P} y2={P+t*(H-2*P)} stroke="rgba(0,0,0,0.04)" strokeWidth="1"/>)}
    <path d={area(v1)} fill={c1} opacity=".08"/>
    <path d={line(v1)} fill="none" stroke={c1} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    {k2&&<path d={area(v2)} fill={c2} opacity=".08"/>}
    {k2&&<path d={line(v2)} fill="none" stroke={c2} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>}
    {data.map((d,i)=><text key={i} x={px(i)} y={H-4} textAnchor="middle" fontSize="8" fill="rgba(0,0,0,0.25)" fontFamily="Azeret Mono">{d.m}</text>)}
  </svg>;
}

/* ════════════════════════════════════════════════
   § 11  LANDING PAGE
════════════════════════════════════════════════ */
const PLAN_LIST = [
  { id:'starter',    name:'Starter',    monthly:4999,  annual:49999,  pop:false, tag:'For one entity getting BRSR-ready', features:['BRSR Core reporting','GRI disclosure mapping','AI reports (10/month)','Carbon + Water tracking','Data entry forms','Email support'], dim:['SASB/TCFD','Supply chain','Multi-entity'] },
  { id:'growth',     name:'Growth',     monthly:14999, annual:149999, pop:true,  tag:'For sustainability teams managing full ESG', features:['Everything in Starter','SASB + TCFD frameworks','Unlimited AI reports','Full workflow module','Supply chain module','Diversity analytics','Audit trail & verifier portal','Priority support'], dim:[] },
  { id:'enterprise', name:'Enterprise', monthly:null,  annual:null,   pop:false, tag:'For multi-entity, listed companies', features:['Everything in Growth','Unlimited entities','White-label reports','Dedicated CSM','VAPT audit','SLA 99.9%'], dim:[] },
];
const FAQS_DATA = [
  ['Is SustainIQ officially certified by SEBI?','SustainIQ is not a SEBI-registered entity. We are a software platform that helps prepare BRSR disclosures. Your statutory auditor or SEBI-registered assurance provider reviews and signs off on the final submission.'],
  ['Does data persist between sessions?','Yes -- all your ESG data, tasks, reports and team members are saved and restored every time you log in. Data is isolated per organisation (multi-tenant architecture).'],
  ['Can multiple departments use the platform?','Yes -- from Growth plan onwards you get unlimited user seats with role-based access. Each department head gets their own login and only sees their assigned tasks.'],
  ['What happens when BRSR requirements change?','Our framework mapping engine is updated within 14 days of any SEBI circular update. All customers get updated templates automatically.'],
  ['Is my data secure?','In this demo, data is stored in your browser localStorage. The production version uses AWS Mumbai (ap-south-1), AES-256 encryption at rest, TLS 1.3, and SOC 2 Type II certification.'],
  ['Do you offer a free trial?','Yes -- every signup gets a 14-day free trial of the Growth plan with full features. No credit card required.'],
];

function LandingPage({ onAuth, onGetStarted }) {
  const [annual, setAnnual] = useState(true);
  const [openFaq, setOpenFaq] = useState(null);
  const [scrolled, setScrolled] = useState(false);
  const pricingRef = useRef(null);
  useEffect(() => { const h = () => setScrolled(window.scrollY > 20); window.addEventListener('scroll', h); return () => window.removeEventListener('scroll', h); }, []);
  return (
    <div className="landing">
      <nav className={`lnav${scrolled?' scrolled':''}`}>
        <div style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer'}}>
          <div className="sb-logo-mark">S</div>
          <span className="sb-logo-text">Sustain<em>IQ</em></span>
        </div>
        <div style={{display:'flex',gap:4}}>
          {['Platform','BRSR Guide','Pricing','Blog'].map(l=><button key={l} style={{padding:'7px 14px',background:'none',border:'none',cursor:'pointer',fontSize:13,fontWeight:500,color:'var(--ink3)',fontFamily:"'Plus Jakarta Sans',sans-serif",borderRadius:'var(--r-sm)'}}>{l}</button>)}
        </div>
        <div style={{display:'flex',gap:8}}>
          <button className="btn btn-ghost btn-sm" onClick={()=>onAuth('login')}>Sign In</button>
          <button className="btn btn-ink btn-sm" onClick={()=>onGetStarted('growth')}>Free Trial -></button>
        </div>
      </nav>

      {/* Hero */}
      <section className="hero">
        <div className="hero-bg"/><div className="hero-grid"/>
        <div className="hero-inner">
          <div>
            <div className="hero-tag fu"><span className="hero-tag-dot"/>🇮🇳 India's First BRSR + GRI + SASB + TCFD Platform</div>
            <h1 className="hero-h1 fu fu1">ESG Reporting,<br/><em>Finally Simple</em><br/>for India</h1>
            <p className="hero-sub fu fu2">The only platform that maps <strong>SEBI's BRSR Core</strong> to GRI, SASB and TCFD simultaneously. AI-generated, audit-ready compliance reports in 60 seconds.</p>
            <div className="hero-actions fu fu3">
              <button className="btn btn-ink btn-xl" onClick={()=>onGetStarted('growth')}>Start Free 14-Day Trial -></button>
              <button className="btn btn-outline btn-lg" onClick={()=>pricingRef.current?.scrollIntoView({behavior:'smooth'})}>See Pricing</button>
            </div>
            <div className="hero-note fu fu4">No credit card . Setup in 15 minutes . Cancel anytime</div>
          </div>
          <div className="hero-card">
            <div className="hc-header">
              <div style={{fontSize:13,fontWeight:700}}>ESG Dashboard . FY 2024-25</div>
              <div className="hc-live"><span className="hc-live-dot"/>LIVE</div>
            </div>
            <div className="hc-metrics">
              {[{val:'12,840',lbl:'GHG Emissions . tCO₂e',t:'↓8.2%'},{val:'74%',lbl:'Renewable Energy',t:'↑9%'},{val:'4,210',lbl:'Water Usage . ML',t:'↓3.1%'},{val:'42%',lbl:'Women Leaders',t:'↑4%'}].map(m=>(
                <div key={m.lbl} className="hc-metric">
                  <div className="hc-val">{m.val}</div>
                  <div className="hc-lbl">{m.lbl}</div>
                  <div className="hc-trend t-good">{m.t} YoY</div>
                </div>
              ))}
            </div>
            <div style={{marginBottom:10}}>
              <div style={{fontSize:9,fontFamily:"'Azeret Mono',monospace",color:'var(--ink4)',marginBottom:7,fontWeight:700,letterSpacing:1}}>DATA COLLECTION PROGRESS</div>
              {[['Environment','85','#176639'],['HR & Social','92','#1a3fa8'],['Finance','100','#176639'],['Supply Chain','43','#c45208']].map(([l,p,c])=>(
                <div key={l} className="bar-row">
                  <div className="bar-label">{l}</div>
                  <div className="progress-bar" style={{flex:1}}><div className="progress-fill" style={{width:`${p}%`,background:c}}/></div>
                  <div className="bar-pct">{p}%</div>
                </div>
              ))}
            </div>
            <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
              {['BRSR','GRI','SASB','TCFD'].map(f=><Tag key={f} fw={f}/>)}
            </div>
          </div>
        </div>
      </section>

      {/* Stats */}
      <div style={{padding:'0 5vw 0',background:'var(--white)',borderBottom:'1px solid var(--border)'}}>
        <div style={{maxWidth:1100,margin:'0 auto'}}>
          <div className="stats-strip">
            {[['₹4.2Cr','avg compliance cost saved'],['98%','audit pass rate'],['47 min','avg report generation'],['1,000+','companies mandated']].map(([v,l])=>(
              <div key={l} className="stat-strip-item"><div className="stat-strip-val">{v}</div><div className="stat-strip-lbl">{l}</div></div>
            ))}
          </div>
        </div>
      </div>

      {/* Features */}
      <section className="section" style={{background:'var(--bg)'}}>
        <div className="sec-inner">
          <div className="sec-eyebrow">Platform Features</div>
          <h2 className="sec-h2">Everything your ESG team needs,<br/><em>built for India</em></h2>
          <p className="sec-p">Not a Western tool retrofitted. Purpose-built for SEBI's BRSR mandate and India's unique regulatory reality.</p>
          <div className="features-grid">
            {[
              {icon:'🇮🇳',title:'BRSR Core -- All 9 Principles',desc:'Every Essential and Leadership indicator, automated year-on-year comparison, SEBI LODR-format export.',color:'#c2410c'},
              {icon:'✦',title:'AI Report Generator',desc:'Claude-powered reports in GRI, SASB, TCFD and BRSR from your live data. Audit-ready in 60 seconds.',color:'#1a3fa8'},
              {icon:'📊',title:'Real-time ESG Dashboard',desc:'Live KPIs for carbon, water, waste, diversity and supply chain with trend charts and targets.',color:'#176639'},
              {icon:'⚙',title:'Workflow & Data Entry',desc:'Assign data tasks to departments, track deadlines, review submissions with full audit trail.',color:'#7c3aed'},
              {icon:'⛓',title:'Supply Chain Intelligence',desc:'Tier-1 and Tier-2 supplier ESG scoring across environmental, labor and ethics dimensions.',color:'#9a6f00'},
              {icon:'🔒',title:'Multi-tenant Security',desc:'Org-isolated data, role-based access control, immutable audit log, verifier portal ready.',color:'#374151'},
            ].map(f=>(
              <div key={f.title} className="feat-card" style={{'--fc':f.color}}>
                <div className="feat-icon">{f.icon}</div>
                <div className="feat-title">{f.title}</div>
                <div className="feat-desc">{f.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="section" style={{background:'var(--white)'}}>
        <div className="sec-inner">
          <div className="sec-eyebrow">Customer Stories</div>
          <h2 className="sec-h2" style={{marginBottom:40}}>What sustainability leaders say</h2>
          <div className="testimonial-grid">
            {[
              {q:'SustainIQ cut our BRSR preparation time from 6 weeks to 4 days. The cross-framework mapping alone is worth the subscription.',name:'Priya Krishnaswamy',role:'Head of Sustainability . Tata Consumer',ini:'PK'},
              {q:'Finally a platform that understands India. The BRSR Core workflow is exactly how SEBI wants it structured. Our auditors were impressed.',name:'Vikram Nair',role:'CFO . Godrej Industries',ini:'VN'},
              {q:'We manage ESG for 12 client companies. The multi-entity setup and AI report generation have been transformative for our practice.',name:'Deepa Menon',role:'Partner . EY India Sustainability',ini:'DM'},
            ].map(t=>(
              <div key={t.name} className="tc">
                <div className="tc-stars">★★★★★</div>
                <div className="tc-text">"{t.q}"</div>
                <div className="tc-author">
                  <Avatar name={t.ini} size={38}/>
                  <div><div className="tc-name">{t.name}</div><div className="tc-role">{t.role}</div></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="section" style={{background:'var(--bg2)'}} ref={pricingRef} id="pricing">
        <div className="sec-inner">
          <div className="sec-eyebrow">Pricing</div>
          <h2 className="sec-h2" style={{marginBottom:12}}>Simple, transparent <em>pricing</em></h2>
          <p style={{color:'var(--ink3)',fontSize:14,marginBottom:28}}>All plans include BRSR Core. No setup fees. Cancel anytime.</p>
          <div className="pricing-toggle">
            <button className={`pt-opt${!annual?' active':''}`} onClick={()=>setAnnual(false)}>Monthly</button>
            <button className={`pt-opt${annual?' active':''}`} onClick={()=>setAnnual(true)}>Annual <span className="save-tag">Save 30%</span></button>
          </div>
          <div className="pricing-grid">
            {PLAN_LIST.map(p=>(
              <div key={p.id} className={`pc${p.pop?' featured':''}`}>
                {p.pop&&<div className="pc-pop">MOST POPULAR</div>}
                <div className="pc-plan">{p.name}</div>
                {p.monthly ? (<>
                  <div className="pc-price"><span className="pc-cur">₹</span>{(annual?Math.round(p.annual/12):p.monthly).toLocaleString('en-IN')}</div>
                  <div className="pc-period">/ month . {annual?`billed ₹${(p.annual).toLocaleString('en-IN')}/yr`:'billed monthly'}</div>
                </>) : (<><div className="pc-price" style={{fontSize:28}}>Custom</div><div className="pc-period">Contact us</div></>)}
                <div className="pc-tag">{p.tag}</div>
                <div className="pc-div"/>
                <ul className="pc-feats">
                  {p.features.map(f=><li key={f}><span className="ck">✓</span>{f}</li>)}
                  {p.dim?.map(f=><li key={f} className="dim"><span className="ck">✗</span>{f}</li>)}
                </ul>
                <button className={`btn btn-lg ${p.pop?'btn-orange':p.id==='enterprise'?'btn-outline':'btn-ink'}`} style={{width:'100%'}} onClick={()=>p.id!=='enterprise'&&onGetStarted(p.id)}>
                  {p.id==='enterprise'?'Talk to Sales':p.pop?'Start Free Trial ->':'Get Started ->'}
                </button>
                {p.pop&&<div style={{fontSize:10,color:'rgba(255,255,255,0.35)',textAlign:'center',marginTop:8,fontFamily:"'Azeret Mono',monospace"}}>14-day free trial . No card required</div>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="section" style={{background:'var(--white)'}}>
        <div className="sec-inner">
          <div className="sec-eyebrow">FAQ</div>
          <h2 className="sec-h2" style={{marginBottom:32}}>Frequently asked <em>questions</em></h2>
          <div className="faq-list">
            {FAQS_DATA.map(([q,a],i)=>(
              <div key={i} className={`faq-item${openFaq===i?' open':''}`} onClick={()=>setOpenFaq(openFaq===i?null:i)}>
                <div className="faq-q">{q}<span className="faq-toggle">+</span></div>
                <div className="faq-a">{a}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <div className="cta-banner">
        <h2 style={{fontFamily:"'DM Serif Display',serif",fontSize:'clamp(28px,4vw,44px)',fontWeight:400,color:'white',marginBottom:14}}>Start your BRSR journey today</h2>
        <p style={{fontSize:15,color:'rgba(255,255,255,0.5)',marginBottom:28,lineHeight:1.6}}>14-day free trial. Setup in 15 minutes. No card required.</p>
        <button className="btn btn-orange btn-xl" onClick={()=>onGetStarted('growth')}>Start Free Trial -></button>
      </div>

      {/* Footer */}
      <footer className="footer">
        <div className="footer-grid">
          <div>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10}}>
              <div className="sb-logo-mark">S</div>
              <span style={{fontSize:16,fontWeight:800,color:'white'}}>Sustain<span style={{color:'#4ade80'}}>IQ</span></span>
            </div>
            <p style={{fontSize:13,lineHeight:1.65,maxWidth:260,marginBottom:16}}>India's only ESG reporting platform purpose-built for SEBI's BRSR mandate. Covering BRSR, GRI, SASB, TCFD.</p>
            <div style={{display:'flex',gap:7,flexWrap:'wrap'}}>
              {[['BRSR ALIGNED','#c2410c'],['GRI COMMUNITY','#176639'],['SSL SECURED','#1a3fa8']].map(([l,c])=>(
                <span key={l} style={{padding:'3px 8px',borderRadius:4,fontSize:9,fontWeight:700,fontFamily:"'Azeret Mono',monospace",background:`${c}22`,color:`${c}cc`,border:`1px solid ${c}33`}}>{l}</span>
              ))}
            </div>
          </div>
          {[{t:'Platform',l:['Dashboard','Data Entry','BRSR Module','AI Reports','Workflow','Framework Matrix']},{t:'Frameworks',l:['BRSR Core Guide','GRI Standards','SASB Metrics','TCFD Pillars','CDP Alignment','UNGC']},{t:'Company',l:['About Us','Blog','Careers','Security','Privacy Policy','Contact']}].map(col=>(
            <div key={col.t}><div className="footer-col-title">{col.t}</div><ul className="footer-links">{col.l.map(l=><li key={l}>{l}</li>)}</ul></div>
          ))}
        </div>
        <div className="footer-bottom">
          <div className="footer-copy">© 2025 SustainIQ Technologies Pvt. Ltd. . CIN: U72900MH2024PTC123456 . Mumbai, India<br/>Not affiliated with SEBI, IFRS Foundation, SASB Foundation, or TCFD. Reports are AI-generated and require professional review before regulatory submission.</div>
          <div style={{display:'flex',gap:14,flexWrap:'wrap'}}>
            {['Privacy','Terms','Security','Cookie Policy'].map(l=><span key={l} style={{fontSize:11,color:'rgba(255,255,255,0.3)',cursor:'pointer'}}>{l}</span>)}
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ════════════════════════════════════════════════
   § 12  AUTH PAGES
════════════════════════════════════════════════ */
function AuthPage({ mode, onSuccess, onSwitch }) {
  const [form, setForm] = useState({ email:'', password:'', firstName:'', lastName:'', company:'', agree:false });
  const [err, setErr] = useState({});
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [resetSent, setResetSent] = useState(null);
  const [newPw, setNewPw] = useState('');
  const set = (k,v) => setForm(p=>({...p,[k]:v}));

  function submit() {
    const e = {};
    if (!form.email.includes('@')) e.email='Valid email required';
    if (form.password.length < 6) e.password='Min 6 characters';
    if (mode==='register') {
      if (!form.firstName.trim()) e.firstName='Required';
      if (!form.company.trim()) e.company='Required';
      if (!form.agree) e.agree='Required';
    }
    setErr(e);
    if (Object.keys(e).length) return;
    setLoading(true);
    setTimeout(() => {
      const result = mode==='register'
        ? Auth.register({ ...form, plan:'growth', billingCycle:'trial' })
        : Auth.login({ email:form.email, password:form.password });
      setLoading(false);
      if (result.error) setErr({ global: result.error });
      else onSuccess(result);
    }, 600);
  }

  function handleForgot() {
    if (!forgotEmail.includes('@')) return;
    const r = Auth.forgotPassword(forgotEmail);
    if (r.success) setResetSent(r.code);
  }
  function handleReset() {
    const r = Auth.resetPassword(forgotEmail, resetCode, newPw);
    if (r.success) { setForgot(false); setResetSent(null); }
    else setErr({ global: r.error });
  }

  if (forgot) return (
    <div className="auth-shell">
      <div className="auth-left"><div className="auth-left-bg"/>
        <div className="auth-left-content">
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:40}}><div className="sb-logo-mark">S</div><span style={{fontSize:18,fontWeight:800,color:'white'}}>Sustain<span style={{color:'#4ade80'}}>IQ</span></span></div>
          <h2 style={{fontFamily:"'DM Serif Display',serif",fontSize:32,color:'white',marginBottom:12,lineHeight:1.1}}>Reset your<br/><em style={{color:'#4ade80'}}>password</em></h2>
          <p style={{color:'rgba(255,255,255,0.5)',fontSize:14,lineHeight:1.6}}>We'll send a verification code to your email.</p>
        </div>
      </div>
      <div className="auth-right">
        <div style={{maxWidth:360,width:'100%'}}>
          <div className="auth-form-title">Forgot Password</div>
          {!resetSent ? <>
            <div className="field"><label>Email Address</label><input type="email" value={forgotEmail} onChange={e=>setForgotEmail(e.target.value)} placeholder="you@company.in"/></div>
            <button className="btn btn-ink btn-lg" style={{width:'100%',marginBottom:12}} onClick={handleForgot}>Send Reset Code</button>
          </> : <>
            <div style={{background:'var(--green-bg)',border:'1px solid var(--green-m)',borderRadius:'var(--r)',padding:12,marginBottom:16,fontSize:13,color:'var(--green)'}}>
              ✓ Code sent! (Demo: <strong>{resetSent}</strong>)
            </div>
            <div className="field"><label>Enter Code</label><input type="text" value={resetCode} onChange={e=>setResetCode(e.target.value)} placeholder="Enter 6-char code"/></div>
            <div className="field"><label>New Password</label><input type="password" value={newPw} onChange={e=>setNewPw(e.target.value)} placeholder="New password (min 6 chars)"/></div>
            {err.global&&<div style={{color:'var(--red)',fontSize:12,marginBottom:10}}>{err.global}</div>}
            <button className="btn btn-green btn-lg" style={{width:'100%',marginBottom:12}} onClick={handleReset}>Reset Password</button>
          </>}
          <button className="btn btn-ghost" style={{width:'100%'}} onClick={()=>{setForgot(false);setResetSent(null)}}>← Back to Login</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="auth-shell">
      <div className="auth-left"><div className="auth-left-bg"/>
        <div className="auth-left-content">
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:40,cursor:'pointer'}}><div className="sb-logo-mark">S</div><span style={{fontSize:18,fontWeight:800,color:'white'}}>Sustain<span style={{color:'#4ade80'}}>IQ</span></span></div>
          <h2 style={{fontFamily:"'DM Serif Display',serif",fontSize:36,color:'white',marginBottom:14,lineHeight:1.1}}>{mode==='login'?<>Welcome<br/>back</>:<>India's #1<br/><em style={{color:'#4ade80'}}>BRSR Platform</em></>}</h2>
          <p style={{color:'rgba(255,255,255,0.5)',fontSize:14,lineHeight:1.6,marginBottom:32}}>{mode==='login'?'Sign in to your ESG workspace and continue where you left off.':'Start your 14-day free trial. No credit card required.'}</p>
          {[['✓','BRSR Core -- all 9 principles'],['✓','GRI, SASB, TCFD mapping'],['✓','AI-generated compliance reports'],['✓','Multi-department workflow']].map(([ic,t])=>(
            <div key={t} style={{display:'flex',gap:10,marginBottom:10,alignItems:'center'}}>
              <span style={{color:'#4ade80',fontWeight:700,fontSize:14}}>{ic}</span>
              <span style={{color:'rgba(255,255,255,0.7)',fontSize:13}}>{t}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="auth-right">
        <div style={{maxWidth:380,width:'100%'}}>
          <div className="auth-form-title">{mode==='login'?'Sign in to your account':'Create your account'}</div>
          <div className="auth-form-sub">{mode==='login'?<>Don't have an account? <span style={{color:'var(--blue)',cursor:'pointer',fontWeight:700}} onClick={()=>onSwitch('register')}>Sign up free -></span></>:<>Already have an account? <span style={{color:'var(--blue)',cursor:'pointer',fontWeight:700}} onClick={()=>onSwitch('login')}>Sign in -></span></>}</div>
          {err.global&&<div style={{background:'var(--red-bg)',border:'1px solid rgba(179,27,27,0.2)',borderRadius:'var(--r-sm)',padding:'10px 14px',fontSize:12,color:'var(--red)',marginBottom:14}}>{err.global}</div>}
          {mode==='register'&&<div className="field-row" style={{marginBottom:14}}>
            <div className="field" style={{marginBottom:0}}><label>First Name *</label><input type="text" className={err.firstName?'bad':form.firstName?'ok':''} value={form.firstName} onChange={e=>set('firstName',e.target.value)} placeholder="Nirav"/>{err.firstName&&<div className="err-msg">{err.firstName}</div>}</div>
            <div className="field" style={{marginBottom:0}}><label>Last Name</label><input type="text" value={form.lastName} onChange={e=>set('lastName',e.target.value)} placeholder="Mehta"/></div>
          </div>}
          {mode==='register'&&<div className="field"><label>Company Name *</label><input type="text" className={err.company?'bad':form.company?'ok':''} value={form.company} onChange={e=>set('company',e.target.value)} placeholder="Acme Fashions Ltd"/>{err.company&&<div className="err-msg">{err.company}</div>}</div>}
          <div className="field"><label>Work Email *</label><input type="email" className={err.email?'bad':form.email.includes('@')?'ok':''} value={form.email} onChange={e=>set('email',e.target.value)} placeholder="you@company.in"/>{err.email&&<div className="err-msg">{err.email}</div>}</div>
          <div className="field"><label>Password *</label>
            <div className="pw-wrap"><input type={showPw?'text':'password'} className={err.password?'bad':form.password.length>=6?'ok':''} value={form.password} onChange={e=>set('password',e.target.value)} placeholder={mode==='register'?'Min 6 characters':'Your password'}/><button className="pw-eye" onClick={()=>setShowPw(p=>!p)}>{showPw?'🙈':'👁'}</button></div>
            {err.password&&<div className="err-msg">{err.password}</div>}
          </div>
          {mode==='login'&&<div style={{textAlign:'right',marginBottom:16}}><span style={{fontSize:12,color:'var(--blue)',cursor:'pointer',fontWeight:600}} onClick={()=>setForgot(true)}>Forgot password?</span></div>}
          {mode==='register'&&<div className="cb-row" style={{marginBottom:14}}>
            <input type="checkbox" checked={form.agree} onChange={e=>set('agree',e.target.checked)}/>
            <span className="cb-label">I agree to <a>Terms of Service</a> and <a>Privacy Policy</a>. I understand SustainIQ is not a SEBI-registered entity. {err.agree&&<span style={{color:'var(--red)'}}>Required.</span>}</span>
          </div>}
          <button className={`btn btn-ink btn-lg${loading?' btn-loading':''}`} style={{width:'100%',marginBottom:14}} onClick={submit} disabled={loading}>
            {loading?'':(mode==='login'?'Sign In ->':'Create Account & Start Trial ->')}
          </button>
          {mode==='register'&&<div style={{fontSize:11,color:'var(--ink4)',textAlign:'center',fontFamily:"'Azeret Mono',monospace"}}>14-day free trial . No credit card required</div>}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════
   § 13  CHECKOUT FLOW
════════════════════════════════════════════════ */
function CheckoutFlow({ planId, onBack, onComplete, existingAuth }) {
  const [step, setStep] = useState(existingAuth ? 2 : 1);
  const [accountResult, setAccountResult] = useState(existingAuth || null);
  const [payResult, setPayResult] = useState(null);
  const plan = PLAN_LIST.find(p=>p.id===planId) || PLAN_LIST[1];
  const [annual, setAnnual] = useState(true);

  const price = annual ? plan.annual : plan.monthly * 12;
  const gst = price ? Math.round(price*0.18) : 0;
  const total = price ? price + gst : 0;
  const monthly = price ? (annual?Math.round(plan.annual/12):plan.monthly) : 0;

  const steps = ['Account','Payment','Confirm'];
  const done = [step>1,step>2,false];

  return (
    <div className="checkout-shell">
      <nav className="checkout-nav">
        <div style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer'}} onClick={onBack}><div className="sb-logo-mark">S</div><span className="sb-logo-text">Sustain<em>IQ</em></span></div>
        <div className="checkout-steps">
          {steps.map((s,i)=><>
            <div key={s} className={`cs${step===i+1?' active':done[i]?' done':''}`}><div className="cs-num">{done[i]?'✓':i+1}</div><span>{s}</span></div>
            {i<steps.length-1&&<div className={`cs-sep${done[i]?' done':''}`}/>}
          </>)}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Plans</button>
      </nav>

      {step===3 ? (
        <SuccessScreen plan={plan} annual={annual} payResult={payResult} onGo={onComplete}/>
      ) : (
        <div className="checkout-body">
          <div className="checkout-layout">
            <div>
              {step===1&&<AccountStep plan={plan} annual={annual} onNext={r=>{setAccountResult(r);setStep(2)}} onBack={onBack}/>}
              {step===2&&<PaymentStep plan={plan} annual={annual} price={price} total={total} gst={gst} accountResult={accountResult} onSuccess={r=>{setPayResult(r);setStep(3)}} onBack={()=>setStep(existingAuth?1:1)}/>}
            </div>
            <div className="order-summary">
              <div className="os-plan-row">
                <div><div className="os-plan-name">{plan.name} Plan</div><div className="os-plan-period">{annual?'Billed Annually':'Billed Monthly'}</div></div>
                <div><div className="os-price-val">₹{monthly.toLocaleString('en-IN')}</div><div className="os-price-mo">/month</div></div>
              </div>
              <ul className="os-feats">{plan.features.slice(0,5).map(f=><li key={f}>{f}</li>)}{plan.features.length>5&&<li style={{color:'var(--ink4)',fontSize:11}}>+{plan.features.length-5} more</li>}</ul>
              {price&&<div className="os-total">
                <div className="os-row"><span>Subtotal</span><span>₹{price.toLocaleString('en-IN')}</span></div>
                <div className="os-row"><span>GST (18%)</span><span>₹{gst.toLocaleString('en-IN')}</span></div>
                <div className="os-final"><span>Total today</span><span>₹{total.toLocaleString('en-IN')}</span></div>
              </div>}
              <div className="os-secure">🔒 Secured by Razorpay . SSL Encrypted</div>
              <div className="os-change" onClick={onBack}>Change plan</div>
              <div className="guarantee-box">
                <div style={{fontSize:12,fontWeight:700,color:'var(--green)',marginBottom:3}}>🛡 14-day money-back guarantee</div>
                <div style={{fontSize:11,color:'var(--ink3)',lineHeight:1.5}}>Not satisfied within 14 days? Full refund, no questions asked.</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AccountStep({ plan, annual, onNext, onBack }) {
  const [f, setF] = useState({firstName:'',lastName:'',email:'',phone:'',company:'',gstin:'',addGst:false,password:'',confirm:'',agree:false});
  const [err, setErr] = useState({});
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const set = (k,v) => setF(p=>({...p,[k]:v}));
  function go() {
    const e = {};
    if (!f.firstName.trim()) e.firstName='Required';
    if (!f.email.includes('@')) e.email='Valid email required';
    if (!f.company.trim()) e.company='Required';
    if (f.password.length<6) e.password='Min 6 characters';
    if (f.password!==f.confirm) e.confirm="Passwords don't match";
    if (!f.agree) e.agree='Required';
    setErr(e); if (Object.keys(e).length) return;
    setLoading(true);
    setTimeout(()=>{
      const r = Auth.register({...f, plan:plan.id, billingCycle:annual?'annual':'monthly'});
      setLoading(false);
      if (r.error) setErr({global:r.error});
      else onNext(r);
    },700);
  }
  return (
    <div className="card-xl fu">
      <h2 style={{fontFamily:"'DM Serif Display',serif",fontSize:22,marginBottom:6}}>Create your account</h2>
      <p style={{color:'var(--ink3)',fontSize:13,marginBottom:22}}>Set up your SustainIQ workspace. Invite team members after signup.</p>
      {err.global&&<div style={{background:'var(--red-bg)',border:'1px solid rgba(179,27,27,0.15)',borderRadius:'var(--r-sm)',padding:'10px 14px',fontSize:12,color:'var(--red)',marginBottom:14}}>{err.global}</div>}
      <div className="field-row" style={{marginBottom:14}}>
        <div className="field" style={{marginBottom:0}}><label>First Name *</label><input className={err.firstName?'bad':f.firstName?'ok':''} value={f.firstName} onChange={e=>set('firstName',e.target.value)} placeholder="Nirav"/>{err.firstName&&<div className="err-msg">{err.firstName}</div>}</div>
        <div className="field" style={{marginBottom:0}}><label>Last Name</label><input value={f.lastName} onChange={e=>set('lastName',e.target.value)} placeholder="Mehta"/></div>
      </div>
      <div className="field-row" style={{marginBottom:14}}>
        <div className="field" style={{marginBottom:0}}><label>Work Email *</label><input type="email" className={err.email?'bad':f.email.includes('@')?'ok':''} value={f.email} onChange={e=>set('email',e.target.value)} placeholder="you@company.in"/>{err.email&&<div className="err-msg">{err.email}</div>}</div>
        <div className="field" style={{marginBottom:0}}><label>Mobile</label><input type="tel" value={f.phone} onChange={e=>set('phone',e.target.value)} placeholder="+91 98765 43210"/></div>
      </div>
      <div className="field"><label>Company Name *</label><input className={err.company?'bad':f.company?'ok':''} value={f.company} onChange={e=>set('company',e.target.value)} placeholder="Acme Fashions Ltd"/>{err.company&&<div className="err-msg">{err.company}</div>}</div>
      <div className="cb-row" style={{marginBottom:12}}><input type="checkbox" checked={f.addGst} onChange={e=>set('addGst',e.target.checked)}/><span className="cb-label" style={{fontSize:13,fontWeight:600,color:'var(--blue)'}}>Add GST details for tax invoice</span></div>
      {f.addGst&&<div className="field-row" style={{marginBottom:14}}>
        <div className="field" style={{marginBottom:0}}><label>GSTIN</label><input value={f.gstin} onChange={e=>set('gstin',e.target.value.toUpperCase())} placeholder="27AABCU9603R1ZX"/></div>
        <div className="field" style={{marginBottom:0}}><label>Billing State</label><select><option>Maharashtra</option><option>Delhi</option><option>Karnataka</option><option>Gujarat</option><option>Tamil Nadu</option><option>Telangana</option></select></div>
      </div>}
      <div className="field-row" style={{marginBottom:14}}>
        <div className="field" style={{marginBottom:0}}><label>Password *</label><div className="pw-wrap"><input type={showPw?'text':'password'} className={err.password?'bad':f.password.length>=6?'ok':''} value={f.password} onChange={e=>set('password',e.target.value)} placeholder="Min 6 characters"/><button className="pw-eye" onClick={()=>setShowPw(p=>!p)}>{showPw?'🙈':'👁'}</button></div>{err.password&&<div className="err-msg">{err.password}</div>}</div>
        <div className="field" style={{marginBottom:0}}><label>Confirm Password *</label><input type="password" className={err.confirm?'bad':f.confirm&&f.confirm===f.password?'ok':''} value={f.confirm} onChange={e=>set('confirm',e.target.value)} placeholder="Repeat password"/>{err.confirm&&<div className="err-msg">{err.confirm}</div>}</div>
      </div>
      <div className="cb-row"><input type="checkbox" checked={f.agree} onChange={e=>set('agree',e.target.checked)}/><span className="cb-label">I agree to <a>Terms of Service</a> and <a>Privacy Policy</a>. I understand SustainIQ is not a SEBI-registered entity. Reports are AI-generated and require professional review. {err.agree&&<span style={{color:'var(--red)'}}>Required.</span>}</span></div>
      <div className="cb-row"><input type="checkbox"/><span className="cb-label">Send me BRSR regulatory updates (optional)</span></div>
      <div style={{display:'flex',justifyContent:'space-between',marginTop:20,alignItems:'center'}}>
        <button className="btn btn-ghost" onClick={onBack}>← Back</button>
        <button className={`btn btn-ink btn-lg${loading?' btn-loading':''}`} onClick={go} disabled={loading}>{loading?'':'Continue to Payment ->'}</button>
      </div>
    </div>
  );
}

function PaymentStep({ plan, annual, price, total, gst, accountResult, onSuccess, onBack }) {
  const [method, setMethod] = useState('card');
  const [cardNum, setCardNum] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvv, setCvv] = useState('');
  const [cardName, setCardName] = useState('');
  const [brand, setBrand] = useState('');
  const [upi, setUpi] = useState('');
  const [upiProv, setUpiProv] = useState(null);
  const [nb, setNb] = useState('');
  const [loading, setLoading] = useState(false);

  const fmtCard = v => { const d=v.replace(/\D/g,'').slice(0,16); setBrand(d.startsWith('4')?'VISA':d.startsWith('5')?'MASTERCARD':d.startsWith('6')?'RUPAY':d.length>0?'CARD':''); return d.replace(/(.{4})/g,'$1 ').trim(); };
  const fmtExp = v => { const d=v.replace(/\D/g,'').slice(0,4); return d.length>2?d.slice(0,2)+'/'+d.slice(2):d; };
  const ready = method==='card'?(cardNum.replace(/\s/g,'').length===16&&expiry.length===5&&cvv.length===3&&cardName.trim().length>0):method==='upi'?(upi.includes('@')||upiProv):nb.length>0;

  function pay() {
    setLoading(true);
    setTimeout(()=>{
      const r = Billing.processPayment({ orgId:accountResult.org.id, userId:accountResult.user.id, plan:plan.id, billingCycle:annual?'annual':'monthly', paymentMethod:method, cardLast4:cardNum.slice(-4) });
      setLoading(false);
      if (r.success) onSuccess(r);
    }, 2000);
  }

  return (
    <div className="card-xl fu">
      <h2 style={{fontFamily:"'DM Serif Display',serif",fontSize:22,marginBottom:6}}>Payment details</h2>
      <p style={{color:'var(--ink3)',fontSize:13,marginBottom:20}}>Subscription starts immediately. 14-day money-back guarantee.</p>
      <div className="pay-method-tabs">
        {[{id:'card',icon:'💳',lbl:'Card'},{id:'upi',icon:'📱',lbl:'UPI'},{id:'nb',icon:'🏦',lbl:'Net Banking'}].map(m=>(
          <button key={m.id} className={`pm-tab${method===m.id?' active':''}`} onClick={()=>setMethod(m.id)}><span className="pm-tab-icon">{m.icon}</span>{m.lbl}</button>
        ))}
      </div>
      {method==='card'&&<>
        <div className="field" style={{marginBottom:14}}><label>Card Number</label>
          <div className="card-wrap">
            <div className="card-num-row">💳<input className="card-num-input" placeholder="1234 5678 9012 3456" maxLength={19} value={cardNum} onChange={e=>setCardNum(fmtCard(e.target.value))}/>{brand&&<span className="card-brand">{brand}</span>}</div>
            <div className="card-r2"><input className="card-exp" placeholder="MM/YY" maxLength={5} value={expiry} onChange={e=>setExpiry(fmtExp(e.target.value))}/><input className="card-cvv" placeholder="CVV" maxLength={3} type="password" value={cvv} onChange={e=>setCvv(e.target.value.replace(/\D/g,'').slice(0,3))}/></div>
          </div>
        </div>
        <div className="field"><label>Name on Card</label><input value={cardName} onChange={e=>setCardName(e.target.value)} placeholder="NIRAV MEHTA"/></div>
        <div style={{fontSize:11,color:'var(--ink4)',fontFamily:"'Azeret Mono',monospace",marginBottom:8}}>🔒 256-bit SSL . Visa . Mastercard . RuPay . Amex</div>
      </>}
      {method==='upi'&&<>
        <div style={{fontSize:13,color:'var(--ink3)',marginBottom:12}}>Select UPI app or enter UPI ID:</div>
        <div className="upi-providers">
          {['GPay','PhonePe','Paytm','BHIM','Amazon Pay'].map(p=>(
            <button key={p} className={`upi-opt${upiProv===p?' sel':''}`} onClick={()=>{setUpiProv(p);setUpi('')}}>{p}</button>
          ))}
        </div>
        <div className="field"><label>UPI ID</label><input value={upi} onChange={e=>{setUpi(e.target.value);setUpiProv(null)}} placeholder="yourname@upi"/></div>
        <div style={{fontSize:11,color:'var(--ink4)',fontFamily:"'Azeret Mono',monospace"}}>✓ Instant . ✓ No extra charges . ✓ NPCI powered</div>
      </>}
      {method==='nb'&&<>
        <div style={{fontSize:13,color:'var(--ink3)',marginBottom:12}}>Select your bank:</div>
        <div className="nb-grid">
          {['HDFC Bank','ICICI Bank','SBI','Axis Bank','Kotak Bank','Yes Bank'].map(b=>(
            <div key={b} className={`nb-opt${nb===b?' sel':''}`} onClick={()=>setNb(b)}>{b}</div>
          ))}
        </div>
        <select className="fsel" style={{width:'100%',marginBottom:12}} value={nb} onChange={e=>setNb(e.target.value)}><option value="">Other banks...</option>{['Bank of Baroda','Punjab National Bank','Canara Bank','Union Bank','IDFC First','IndusInd'].map(b=><option key={b}>{b}</option>)}</select>
      </>}
      <div style={{display:'flex',justifyContent:'space-between',marginTop:20,alignItems:'center'}}>
        <button className="btn btn-ghost" onClick={onBack}>← Back</button>
        <button className={`btn btn-green btn-lg${loading?' btn-loading':''}`} disabled={!ready||loading} onClick={pay} style={{minWidth:180}}>
          {loading?'Processing...':`Pay ₹${total.toLocaleString('en-IN')}`}
        </button>
      </div>
      <div style={{textAlign:'center',marginTop:12,fontSize:10,color:'var(--ink4)',fontFamily:"'Azeret Mono',monospace"}}>🔒 Secured by Razorpay . 18% GST included . Cancel anytime</div>
    </div>
  );
}

function SuccessScreen({ plan, annual, payResult, onGo }) {
  const orderId = payResult?.invoice?.orderId || 'SIQ-DEMO';
  const price = annual ? plan.annual : (plan.monthly||0)*12;
  const total = price ? Math.round(price*1.18) : 0;
  return (
    <div className="success-screen fu">
      <div className="success-ring">✓</div>
      <h1 style={{fontFamily:"'DM Serif Display',serif",fontSize:36,marginBottom:10}}>Welcome to SustainIQ!</h1>
      <p style={{fontSize:15,color:'var(--ink3)',maxWidth:420,lineHeight:1.65,marginBottom:24,textAlign:'center'}}>Your <strong>{plan.name}</strong> subscription is active. Your workspace is ready.</p>
      <div className="success-plan-box">
        {[['Plan',plan.name],['Billing',annual?'Annual':'Monthly'],['Amount Paid',total?`₹${total.toLocaleString('en-IN')} incl. GST`:'Free Trial'],['Order ID',orderId],['Trial ends',new Date(Date.now()+14*86400000).toLocaleDateString('en-IN')]].map(([l,v])=>(
          <div key={l} className="spb-row"><span style={{color:'var(--ink3)'}}>{l}</span><span style={{fontWeight:700}}>{v}</span></div>
        ))}
      </div>
      <div className="next-steps">
        {['Check your email for login confirmation and onboarding guide','Complete your company profile (CIN, sector, reporting boundary)','Assign data collection tasks to your department heads','Your AI report is ready once data is entered -- generates in 60 seconds'].map((s,i)=>(
          <div key={i} className="next-step"><div className="next-step-num">{i+1}</div><div>{s}</div></div>
        ))}
      </div>
      <button className="btn btn-green btn-xl" onClick={onGo}>Go to Dashboard -></button>
      <div style={{fontSize:11,color:'var(--ink4)',marginTop:12,fontFamily:"'Azeret Mono',monospace"}}>Invoice emailed . Tax receipt generated</div>
    </div>
  );
}

/* ════════════════════════════════════════════════
   § 14  MAIN APP DASHBOARD
════════════════════════════════════════════════ */
function AppShell() {
  const { user, org, addToast, logout, refreshSession } = useApp();
  const [page, setPage] = useState('overview');
  const [showNotif, setShowNotif] = useState(false);
  // Always read live org from DB so billing/settings updates reflect immediately
  const liveOrg = DB.getOne('orgs', org?.id) || org;
  const notifs = DB.where('notifications', n => n.orgId === liveOrg.id).reverse().slice(0,20);
  const unread = notifs.filter(n => !n.read).length;
  const progress = WorkflowService.getProgress(liveOrg.id);
  const isTrial = liveOrg.subscriptionStatus === 'trial';
  const trialDaysLeft = liveOrg.trialEnds ? Math.max(0, Math.ceil((new Date(liveOrg.trialEnds)-Date.now())/86400000)) : 0;
  const scoreVal = ESGService.getScore(liveOrg.id);

  const NAV = [
    { id:'overview',    ic:'⬡', label:'Overview',        sec:'MAIN' },
    { id:'data-entry',  ic:'✎', label:'Data Entry',       sec:'MAIN' },
    { id:'workflow',    ic:'☑', label:'Workflow Tasks',   sec:'MAIN', badge: WorkflowService.getTasks(liveOrg.id,{status:'not_started'}).length || null },
    { id:'reports',     ic:'✦', label:'Generate Reports', sec:'REPORTS' },
    { id:'report-hist', ic:'📄', label:'Report History',  sec:'REPORTS' },
    { id:'audit',       ic:'🔐', label:'Audit Trail',     sec:'REPORTS' },
    { id:'team',        ic:'👥', label:'Team & Roles',    sec:'SETTINGS' },
    { id:'billing',     ic:'💳', label:'Billing',         sec:'SETTINGS' },
    { id:'settings',    ic:'⚙', label:'Settings',        sec:'SETTINGS' },
  ];

  const pageTitles = { overview:'Overview', 'data-entry':'Data Entry', workflow:'Workflow Tasks', reports:'Generate Reports', 'report-hist':'Report History', audit:'Audit Trail', team:'Team & Roles', billing:'Billing & Invoices', settings:'Settings' };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sb-logo" onClick={logout}>
          <div className="sb-logo-mark">S</div>
          <div><div className="sb-logo-text">Sustain<em>IQ</em></div><span className="sb-logo-sub">ESG PLATFORM</span></div>
        </div>
        {['MAIN','REPORTS','SETTINGS'].map(sec=>(
          <div key={sec}>
            <div className="sb-section">{sec}</div>
            {NAV.filter(n=>n.sec===sec).map(n=>(
              <div key={n.id} className={`sb-item${page===n.id?' active':''}`} onClick={()=>setPage(n.id)}>
                <span className="ic">{n.ic}</span>{n.label}
                {n.badge ? <span className="sb-badge">{n.badge}</span> : null}
              </div>
            ))}
          </div>
        ))}
        <div className="sb-score">
          <div className="sb-score-label">ESG SCORE</div>
          <div className="sb-score-num">{scoreVal}</div>
          <div className="sb-score-bar"><div className="sb-score-fill" style={{width:`${scoreVal}%`}}/></div>
          <div style={{fontSize:10,color:'var(--ink3)',fontFamily:"'Azeret Mono',monospace"}}>{progress.done}/{progress.total} tasks . {progress.pct}% done</div>
        </div>
        <div className="sb-user">
          <Avatar name={`${user.firstName} ${user.lastName}`} size={30}/>
          <div><div className="sb-user-name">{user.firstName} {user.lastName}</div><div className="sb-user-role">{user.role}</div></div>
          <div className="sb-plan">{org.plan?.toUpperCase()}</div>
        </div>
      </aside>

      <div className="main-area">
        {isTrial&&<div className="banner">🎁 Free trial -- {trialDaysLeft} days remaining<button className="btn btn-orange btn-sm" style={{marginLeft:8}} onClick={()=>setPage('billing')}>Upgrade Now</button><span style={{fontSize:11,opacity:0.7}}>No credit card yet . All features unlocked</span></div>}
        <div className="topbar">
          <div><div className="tb-title">{pageTitles[page]}</div><div className="tb-sub">{org.name} . {org.reportingYear}</div></div>
          <div className="tb-right">
            <div className={`plan-chip${org.subscriptionStatus==='active'?' active':''}`}>{org.subscriptionStatus==='trial'?`TRIAL . ${trialDaysLeft}d`:org.plan?.toUpperCase()}</div>
            <div className="tb-notif" onClick={()=>setShowNotif(p=>!p)}>
              🔔{unread>0&&<div className="tb-notif-dot"/>}
            </div>
            <button className="btn btn-ink btn-sm" onClick={()=>setPage('reports')}>✦ Generate Report</button>
          </div>
        </div>

        <div className="page">
          {page==='overview'      && <OverviewPage/>}
          {page==='data-entry'    && <DataEntryPage/>}
          {page==='workflow'      && <WorkflowPage/>}
          {page==='reports'       && <ReportsPage/>}
          {page==='report-hist'   && <ReportHistPage/>}
          {page==='audit'         && <AuditPage/>}
          {page==='team'          && <TeamPage/>}
          {page==='billing'       && <BillingPage onUpgrade={()=>setPage('billing')}/>}
          {page==='settings'      && <SettingsPage/>}
        </div>

        {showNotif&&<NotifPanel notifs={notifs} onClose={()=>setShowNotif(false)}/>}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════
   § 15  OVERVIEW PAGE
════════════════════════════════════════════════ */
function OverviewPage() {
  const { org, user } = useApp();
  const all = ESGService.getAll(org.id);
  const tasks = WorkflowService.getTasks(org.id);
  const progress = WorkflowService.getProgress(org.id);
  const em = all.emissions || {};
  const w = all.water || {};
  const s = all.social || {};
  const g = all.governance || {};

  const MONTHLY = [
    {m:'Apr',c:1180,w:390},{m:'May',c:1090,w:355},{m:'Jun',c:1040,w:342},
    {m:'Jul',c:970,w:318},{m:'Aug',c:1010,w:332},{m:'Sep',c:945,w:304},
    {m:'Oct',c:1070,w:328},{m:'Nov',c:1010,w:312},{m:'Dec',c:985,w:298},
    {m:'Jan',c:1030,w:286},{m:'Feb',c:945,w:277},{m:'Mar',c:em.scope1_gas?900:null,w:w.water_total?268:null},
  ].filter(d=>d.c);

  const kpis = [
    {icon:'🌫',label:'Total GHG',val:em.scope1_gas?((+em.scope1_gas||0)+(+em.scope2_elec||0)+(+em.scope3_travel||0)+(+em.scope3_supply||0)).toLocaleString():'--',unit:'tCO₂e',c:'var(--green)'},
    {icon:'⚡',label:'Renewable %',val:em.elec_renewable||'--',unit:'%',c:'var(--gold)'},
    {icon:'💧',label:'Water Used',val:w.water_total||(w.water_surface?(+w.water_surface+(+w.water_ground||0)+(+w.water_municipal||0)).toLocaleString():'--'),unit:'ML',c:'var(--blue)'},
    {icon:'♀',label:'Women Leaders',val:s.women_senior||'--',unit:'%',c:'var(--violet)'},
    {icon:'👥',label:'Employees',val:s.headcount_total||'--',unit:'',c:'var(--green)'},
    {icon:'💰',label:'CSR Spend',val:g.csr_spend?`₹${g.csr_spend}Cr`:'--',unit:'',c:'var(--orange)'},
    {icon:'⛓',label:'Supplier Cover',val:g.suppliers_assessed&&g.suppliers_total?`${Math.round(g.suppliers_assessed/g.suppliers_total*100)}%`:'--',unit:'',c:'var(--gold)'},
    {icon:'📊',label:'Tasks Done',val:`${progress.pct}%`,unit:'',c:'var(--green)'},
  ];

  return (
    <div className="fu">
      <div className="section-head"><div><div className="section-title">Welcome back, {user.firstName} 👋</div><div style={{fontSize:12,color:'var(--ink3)',marginTop:2}}>{org.name} . {org.reportingYear} . {progress.done}/{progress.total} tasks complete</div></div></div>

      <div className="kpi-grid">
        {kpis.map(k=>(
          <div key={k.label} className="kpi" style={{'--kc':k.c}}>
            <div className="kpi-icon">{k.icon}</div>
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-val">{k.val}<span className="kpi-unit">{k.unit}</span></div>
          </div>
        ))}
      </div>

      <div className="chart-row">
        <div className="card">
          <div className="card-head"><div className="card-title">Monthly GHG & Water Trend</div><div className="card-sub">{org.reportingYear}</div></div>
          <LineChart data={MONTHLY} k1="c" k2="w"/>
          <div style={{display:'flex',gap:14,marginTop:8}}>
            <div style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:'var(--ink3)'}}><span style={{width:8,height:8,borderRadius:'50%',background:'var(--green)',display:'inline-block'}}/> Carbon (tCO₂e)</div>
            <div style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:'var(--ink3)'}}><span style={{width:8,height:8,borderRadius:'50%',background:'var(--blue)',display:'inline-block'}}/> Water (ML)</div>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><div className="card-title">Collection Progress</div></div>
          {['Environment & Facilities','Human Resources','Finance & Accounts','Procurement / SCM','Operations & EHS','Legal & Compliance'].map(dept=>{
            const deptTasks = tasks.filter(t=>t.dept===dept);
            const deptDone = deptTasks.filter(t=>t.status==='submitted'||t.status==='approved').length;
            const pct = deptTasks.length ? Math.round(deptDone/deptTasks.length*100) : 0;
            return (
              <div key={dept} className="bar-row">
                <div className="bar-label">{dept.split(' ')[0]}</div>
                <div className="progress-bar" style={{flex:1}}><div className="progress-fill" style={{width:`${pct}%`,background:pct===100?'var(--green)':pct>50?'var(--blue)':'var(--orange)'}}/></div>
                <div className="bar-pct">{pct}%</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="tbl-wrap">
        <div className="tbl-toolbar"><div className="tbl-title">Recent Tasks</div></div>
        <table>
          <thead><tr><th>Indicator</th><th>Dept</th><th>Status</th><th>Priority</th><th>Frameworks</th></tr></thead>
          <tbody>
            {tasks.slice(0,7).map(t=>{
              const sm = {submitted:{l:'Submitted',c:'green'},in_review:{l:'In Review',c:'blue'},in_progress:{l:'In Progress',c:'amber'},not_started:{l:'Not Started',c:'ink'},approved:{l:'Approved',c:'green'}};
              const s2 = sm[t.status] || sm.not_started;
              return (
                <tr key={t.id}>
                  <td style={{fontWeight:600,maxWidth:220}}>{t.title}</td>
                  <td style={{fontSize:11,color:'var(--ink3)'}}>{t.dept.split(' ')[0]}</td>
                  <td><Pill label={s2.l} color={s2.c}/></td>
                  <td><Pill label={t.priority?.toUpperCase()||'--'} color={t.priority==='high'?'red':t.priority==='medium'?'amber':'ink'}/></td>
                  <td><div style={{display:'flex',gap:3}}>{(Array.isArray(t.fw)?t.fw:[]).map(f=><Tag key={f} fw={f}/>)}</div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════
   § 16  DATA ENTRY PAGE
════════════════════════════════════════════════ */
function DataEntryPage() {
  const { org, user, addToast } = useApp();
  const [mod, setMod] = useState('emissions');
  const [saved, setSaved] = useState({});

  const initData = () => ESGService.get(org.id, mod);
  const [form, setForm] = useState(initData);
  useEffect(() => { setForm(ESGService.get(org.id, mod)); }, [mod]);

  const set = (k,v) => setForm(p=>({...p,[k]:v}));

  function save() {
    ESGService.save(org.id, user.id, mod, form);
    setSaved(p=>({...p,[mod]:true}));
    addToast({msg:`${mod.charAt(0).toUpperCase()+mod.slice(1)} data saved & submitted`,type:'ok',icon:'✓'});
  }

  const FW = ({tags}) => <div style={{display:'flex',gap:3,marginTop:3}}>{tags.map(t=><Tag key={t} fw={t}/>)}</div>;
  const F = ({label,k,unit,hint,fw=[],type='number',opts=null,full=false}) => (
    <div className={`field${full?' field-full':''}`} style={{marginBottom:14}}>
      <label style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <span>{label}</span>
        <FW tags={fw}/>
      </label>
      {hint&&<div className="hint">{hint}</div>}
      {opts?<select className={form[k]?'ok':''} value={form[k]||''} onChange={e=>set(k,e.target.value)}>{opts.map(o=><option key={o}>{o}</option>)}</select>
        :unit?<div className="input-unit"><input type={type} className={form[k]?'ok':''} value={form[k]||''} onChange={e=>set(k,e.target.value)}/><div className="unit">{unit}</div></div>
        :<input type={type} className={form[k]?'ok':''} value={form[k]||''} onChange={e=>set(k,e.target.value)}/>
      }
    </div>
  );

  const MODS = [{id:'emissions',ic:'🌫',lbl:'Emissions'},{id:'water',ic:'💧',lbl:'Water & Waste'},{id:'social',ic:'👥',lbl:'People'},{id:'governance',ic:'⚖',lbl:'Governance'},{id:'supply',ic:'⛓',lbl:'Supply Chain'}];

  return (
    <div className="fu">
      <div style={{display:'flex',gap:8,marginBottom:20,flexWrap:'wrap'}}>
        {MODS.map(m=>(
          <button key={m.id} className={`btn${mod===m.id?' btn-ink':' btn-outline'}`} onClick={()=>setMod(m.id)}>
            {m.ic} {m.lbl} {saved[m.id]&&<span style={{color:mod===m.id?'#4ade80':'var(--green)'}}>✓</span>}
          </button>
        ))}
      </div>

      <div className="card-xl">
        {mod==='emissions'&&<>
          <div className="card-head"><div><div className="card-title">GHG Emissions Data</div><div className="card-sub">Scope 1, 2 and 3 -- required for BRSR P6, GRI 305, TCFD Metrics</div></div></div>
          <div style={{fontSize:12,fontWeight:700,color:'var(--ink2)',marginBottom:12,paddingBottom:8,borderBottom:'1px solid var(--border)'}}>Scope 1 -- Direct Emissions</div>
          <div className="field-row"><F label="Natural Gas Combustion" k="scope1_gas" unit="tCO₂e" fw={['BRSR','GRI']}/><F label="Company Fleet & Vehicles" k="scope1_fleet" unit="tCO₂e" fw={['BRSR','GRI']}/></div>
          <div style={{fontSize:12,fontWeight:700,color:'var(--ink2)',marginBottom:12,paddingBottom:8,borderBottom:'1px solid var(--border)'}}>Scope 2 -- Purchased Energy</div>
          <div className="field-row"><F label="Purchased Electricity" k="scope2_elec" unit="tCO₂e" fw={['BRSR','GRI','TCFD']}/><F label="Purchased Steam & Heat" k="scope2_steam" unit="tCO₂e" fw={['GRI','TCFD']}/></div>
          <div style={{fontSize:12,fontWeight:700,color:'var(--ink2)',marginBottom:12,paddingBottom:8,borderBottom:'1px solid var(--border)'}}>Scope 3 -- Value Chain</div>
          <div className="field-row"><F label="Business Air Travel" k="scope3_travel" unit="tCO₂e" fw={['BRSR','GRI']}/><F label="Supply Chain Upstream" k="scope3_supply" unit="tCO₂e" fw={['BRSR','GRI','TCFD']}/></div>
          <div className="divider"/>
          <div style={{fontSize:12,fontWeight:700,color:'var(--ink2)',marginBottom:12,paddingBottom:8,borderBottom:'1px solid var(--border)'}}>Energy Mix</div>
          <div className="field-row-3"><F label="Total Electricity (kWh)" k="elec_total" unit="kWh" fw={['BRSR','GRI','SASB']}/><F label="Renewable Energy Share" k="elec_renewable" unit="%" fw={['BRSR','GRI']}/><F label="Net-Zero Target Year" k="netzero_year" unit="year" fw={['TCFD']}/></div>
        </>}

        {mod==='water'&&<>
          <div className="card-head"><div><div className="card-title">Water & Waste Data</div><div className="card-sub">GRI 303, 306 . BRSR P6 Essential Indicators</div></div></div>
          <div style={{fontSize:12,fontWeight:700,color:'var(--ink2)',marginBottom:12,paddingBottom:8,borderBottom:'1px solid var(--border)'}}>Water Withdrawal by Source (ML)</div>
          <div className="field-row"><F label="Surface Water" k="water_surface" unit="ML" fw={['GRI']}/><F label="Groundwater" k="water_ground" unit="ML" fw={['GRI','BRSR']}/></div>
          <div className="field-row"><F label="Municipal Water" k="water_municipal" unit="ML" fw={['GRI']}/><F label="Water Recycled / Reused" k="water_recycled" unit="ML" fw={['BRSR','GRI']}/></div>
          <div className="divider"/>
          <div style={{fontSize:12,fontWeight:700,color:'var(--ink2)',marginBottom:12,paddingBottom:8,borderBottom:'1px solid var(--border)'}}>Waste Management (tonnes)</div>
          <div className="field-row"><F label="Total Waste Generated" k="waste_total" unit="t" fw={['BRSR','GRI']}/><F label="Waste Recycled" k="waste_recycled" unit="t" fw={['BRSR','GRI']}/></div>
          <div className="field-row"><F label="Waste to Landfill" k="waste_landfill" unit="t" fw={['BRSR','GRI']}/><F label="Hazardous Waste" k="waste_hazardous" unit="t" fw={['BRSR','GRI']} hint="Dispose per PCB norms"/></div>
        </>}

        {mod==='social'&&<>
          <div className="card-head"><div><div className="card-title">People & Social Data</div><div className="card-sub">BRSR P3, P5 . GRI 401, 405 . SASB labor metrics</div></div></div>
          <div style={{fontSize:12,fontWeight:700,color:'var(--ink2)',marginBottom:12,paddingBottom:8,borderBottom:'1px solid var(--border)'}}>Headcount</div>
          <div className="field-row-3"><F label="Total Employees" k="headcount_total" fw={['BRSR','GRI']}/><F label="Permanent" k="headcount_perm" fw={['BRSR']}/><F label="Contract / Temp" k="headcount_contract" fw={['BRSR']}/></div>
          <div className="divider"/>
          <div style={{fontSize:12,fontWeight:700,color:'var(--ink2)',marginBottom:12,paddingBottom:8,borderBottom:'1px solid var(--border)'}}>Diversity</div>
          <div className="field-row-3"><F label="Women -- All Staff" k="women_total" unit="%" fw={['BRSR','GRI']}/><F label="Women -- Senior Leadership" k="women_senior" unit="%" fw={['BRSR']}/><F label="Women -- Board" k="women_board" unit="%" fw={['BRSR']}/></div>
          <div className="divider"/>
          <div style={{fontSize:12,fontWeight:700,color:'var(--ink2)',marginBottom:12,paddingBottom:8,borderBottom:'1px solid var(--border)'}}>Pay Equity (Female : Male ratio)</div>
          <div className="field-row-3"><F label="Entry Level" k="pay_entry" fw={['BRSR']}/><F label="Mid Level" k="pay_mid" fw={['BRSR']}/><F label="Senior Level" k="pay_senior" fw={['BRSR']}/></div>
          <div className="divider"/>
          <div className="field-row-3"><F label="Training Hrs / Employee" k="training_hrs" unit="hrs/yr" fw={['BRSR','GRI']}/><F label="Attrition Rate" k="attrition" unit="%" fw={['BRSR']}/><F label="LTIFR" k="ltifr" fw={['BRSR','GRI','SASB']} hint="Per 1M hours"/></div>
        </>}

        {mod==='governance'&&<>
          <div className="card-head"><div><div className="card-title">Governance & Finance</div><div className="card-sub">BRSR P1, P7 . TCFD Governance . Companies Act CSR</div></div></div>
          <div className="field-row"><F label="Board Independence %" k="board_independence" unit="%" fw={['BRSR','TCFD']}/><F label="ESG Committee" k="esg_committee" fw={['BRSR','TCFD']} opts={['Yes','No','In Formation']}/></div>
          <div className="field-row"><F label="Whistleblower Cases Filed" k="whistle_cases" fw={['BRSR','GRI']}/><F label="Cases Resolved" k="whistle_resolved" fw={['BRSR']}/></div>
          <div className="divider"/>
          <div className="field-row-3"><F label="CSR Spend" k="csr_spend" unit="₹ Cr" fw={['BRSR']}/><F label="% of Avg Net Profit" k="csr_pct" unit="%" fw={['BRSR']} hint="Min 2% per Companies Act"/><F label="Beneficiaries" k="csr_beneficiaries" fw={['BRSR']}/></div>
          <div className="divider"/>
          <div className="field-row"><F label="Total Revenue" k="revenue" unit="₹ Cr" fw={['BRSR','SASB']} hint="For intensity metrics"/><F label="EBITDA Margin" k="ebitda_margin" unit="%" fw={['SASB']}/></div>
        </>}

        {mod==='supply'&&<>
          <div className="card-head"><div><div className="card-title">Supply Chain Sustainability</div><div className="card-sub">BRSR value chain . GRI 308, 414 . SASB CG-AA-430a</div></div></div>
          <div className="field-row-3"><F label="Total Tier-1 Suppliers" k="suppliers_total" fw={['BRSR','GRI']}/><F label="Suppliers ESG-Assessed" k="suppliers_assessed" fw={['BRSR','GRI','SASB']}/><F label="High-Risk Suppliers" k="suppliers_high_risk" fw={['BRSR','GRI']}/></div>
          <div className="field-row"><F label="Supplier Audit Coverage %" k="suppliers_audited_pct" unit="%" fw={['GRI']}/><F label="Avg Supplier ESG Score" k="suppliers_avg_score" unit="/100" fw={['BRSR']}/></div>
          <F label="Supply Chain Notes" k="supply_notes" type="text" fw={['GRI']} hint="Key risks, mitigation actions" full/>
        </>}

        <div style={{display:'flex',justifyContent:'flex-end',marginTop:20,gap:10}}>
          <button className="btn btn-outline" onClick={()=>setForm(ESGService.get(org.id,mod))}>Reset</button>
          <button className="btn btn-green" onClick={save}>✓ Save & Submit {mod.charAt(0).toUpperCase()+mod.slice(1)} Data</button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════
   § 17  WORKFLOW PAGE
════════════════════════════════════════════════ */
function WorkflowPage() {
  const { org, user, addToast } = useApp();
  const [tasks, setTasks] = useState(() => WorkflowService.getTasks(org.id));
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterDept, setFilterDept] = useState('all');
  const [assignModal, setAssignModal] = useState(null);
  const [assignName, setAssignName] = useState('');

  const refresh = () => setTasks(WorkflowService.getTasks(org.id));
  const teamMembers = TeamService.getMembers(org.id);

  const filtered = tasks.filter(t=>{
    const ms = search ? t.title.toLowerCase().includes(search.toLowerCase()) : true;
    const mst = filterStatus==='all' || t.status===filterStatus;
    const md = filterDept==='all' || t.dept===filterDept;
    return ms&&mst&&md;
  });

  const STATUS_META = {submitted:{l:'Submitted',c:'green'},in_review:{l:'In Review',c:'blue'},in_progress:{l:'In Progress',c:'amber'},not_started:{l:'Not Started',c:'ink'},approved:{l:'Approved',c:'green'}};

  function updateStatus(id, status) {
    WorkflowService.updateTask(org.id, user.id, id, {status});
    addToast({msg:`Status -> ${STATUS_META[status].l}`,type:'ok'});
    refresh();
  }
  function assign(task) { setAssignModal(task); setAssignName(''); }
  function doAssign() {
    if (!assignName.trim()) return;
    WorkflowService.assignTask(org.id, user.id, assignModal.id, user.id, assignName);
    addToast({msg:`Assigned to ${assignName}`,type:'ok'});
    setAssignModal(null); refresh();
  }

  const depts = [...new Set(tasks.map(t=>t.dept))];
  const submitted = tasks.filter(t=>t.status==='submitted'||t.status==='approved').length;

  return (
    <div className="fu">
      <div className="kpi-grid" style={{gridTemplateColumns:'repeat(4,1fr)'}}>
        {[{l:'Total Tasks',v:tasks.length,c:'var(--ink)'},{l:'Submitted',v:submitted,c:'var(--green)'},{l:'In Progress',v:tasks.filter(t=>t.status==='in_progress').length,c:'var(--gold)'},{l:'Not Started',v:tasks.filter(t=>t.status==='not_started').length,c:'var(--orange)'}].map(k=>(
          <div key={k.l} className="kpi" style={{'--kc':k.c}}><div className="kpi-label">{k.l}</div><div className="kpi-val" style={{color:k.c}}>{k.v}</div></div>
        ))}
      </div>

      <div className="tbl-wrap">
        <div className="tbl-toolbar">
          <div className="tbl-title">All Tasks ({filtered.length})</div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            <input className="search-box" placeholder="Search tasks..." value={search} onChange={e=>setSearch(e.target.value)}/>
            <select className="fsel" value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}>
              <option value="all">All Status</option>
              {Object.entries(STATUS_META).map(([k,v])=><option key={k} value={k}>{v.l}</option>)}
            </select>
            <select className="fsel" value={filterDept} onChange={e=>setFilterDept(e.target.value)}>
              <option value="all">All Depts</option>
              {depts.map(d=><option key={d}>{d}</option>)}
            </select>
          </div>
        </div>
        <table>
          <thead><tr><th>Indicator</th><th>Dept</th><th>Assignee</th><th>Frameworks</th><th>Priority</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {filtered.map(t=>{
              const sm = STATUS_META[t.status]||STATUS_META.not_started;
              return (
                <tr key={t.id}>
                  <td style={{fontWeight:600,maxWidth:220,fontSize:13}}>{t.title}</td>
                  <td style={{fontSize:11,color:'var(--ink3)'}}>{t.dept.split(' ')[0]}</td>
                  <td>
                    {t.assigneeName&&t.assigneeName!=='Unassigned' ? (
                      <div style={{display:'flex',alignItems:'center',gap:6}}><Avatar name={t.assigneeName} size={22}/><span style={{fontSize:12}}>{t.assigneeName.split(' ')[0]}</span></div>
                    ) : <button className="btn btn-ghost btn-sm" style={{fontSize:11,padding:'3px 8px'}} onClick={()=>assign(t)}>Assign -></button>}
                  </td>
                  <td><div style={{display:'flex',gap:3}}>{(Array.isArray(t.fw)?t.fw:[]).slice(0,3).map(f=><Tag key={f} fw={f}/>)}</div></td>
                  <td><Pill label={t.priority?.toUpperCase()||'--'} color={t.priority==='high'?'red':t.priority==='medium'?'amber':'ink'}/></td>
                  <td><Pill label={sm.l} color={sm.c}/></td>
                  <td>
                    <div style={{display:'flex',gap:4}}>
                      {t.status==='not_started'&&<button className="btn btn-ink btn-sm" style={{fontSize:11}} onClick={()=>updateStatus(t.id,'in_progress')}>Start</button>}
                      {t.status==='in_progress'&&<button className="btn btn-outline btn-sm" style={{fontSize:11}} onClick={()=>updateStatus(t.id,'submitted')}>Submit</button>}
                      {t.status==='submitted'&&<><button className="btn btn-green btn-sm" style={{fontSize:11}} onClick={()=>updateStatus(t.id,'approved')}>✓</button><button className="btn btn-outline btn-sm" style={{fontSize:11}} onClick={()=>updateStatus(t.id,'in_progress')}>Flag</button></>}
                      {t.status==='approved'&&<span style={{fontSize:11,color:'var(--green)',fontFamily:"'Azeret Mono',monospace"}}>✓ Done</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Modal open={!!assignModal} onClose={()=>setAssignModal(null)} title={`Assign: ${assignModal?.title}`}
        footer={<><button className="btn btn-ghost" onClick={()=>setAssignModal(null)}>Cancel</button><button className="btn btn-ink" onClick={doAssign}>Assign</button></>}>
        <div className="field"><label>Assignee Name</label>
          <select value={assignName} onChange={e=>setAssignName(e.target.value)}>
            <option value="">Select team member...</option>
            {teamMembers.map(m=><option key={m.id}>{m.firstName} {m.lastName}</option>)}
          </select>
        </div>
        <div className="field"><label>Or enter name manually</label><input value={assignName} onChange={e=>setAssignName(e.target.value)} placeholder="Name"/></div>
      </Modal>
    </div>
  );
}

/* ════════════════════════════════════════════════
   § 18  REPORTS PAGE
════════════════════════════════════════════════ */
function ReportsPage() {
  const { org, user, addToast } = useApp();
  const [fw, setFw] = useState('BRSR');
  const [sector, setSector] = useState(org.industry||'Apparel & Textile');
  const [year, setYear] = useState(org.reportingYear||'FY 2024-25');
  const [loading, setLoading] = useState(false);
  const [output, setOutput] = useState('');

  const FWS = [
    {id:'BRSR',c:'#c2410c',bg:'#fff3ed',name:'Business Responsibility & Sustainability Reporting',desc:'SEBI-mandated for India top 1000',isNew:true},
    {id:'GRI', c:'#176639',bg:'#e6f4ec',name:'Global Reporting Initiative Standards',desc:'Comprehensive global disclosure'},
    {id:'SASB',c:'#1a3fa8',bg:'#e8edfb',name:'Sustainability Accounting Standards',desc:'Industry-specific financials'},
    {id:'TCFD',c:'#9a6f00',bg:'#fdf5e0',name:'Task Force on Climate-related Disclosures',desc:'Climate risk & scenario analysis'},
  ];

  const canGenerate = Billing.checkAiLimit(org);

  async function generate() {
    if (!canGenerate) { addToast({msg:'AI report limit reached. Upgrade your plan.',type:'err',icon:'⚠'}); return; }
    setLoading(true); setOutput('');
    const all = ESGService.getAll(org.id);
    const em = all.emissions||{}, w = all.water||{}, s = all.social||{}, g = all.governance||{};

    const systemPrompt = `You are a Principal ESG Consultant with 20+ years of experience in SEBI BRSR, GRI Standards, SASB frameworks and TCFD. You specialize in sustainability reporting for Indian listed companies. Write professional, audit-ready disclosure language. Be specific and data-driven.`;

    const dataBlock = `
COMPANY: ${org.name} | SECTOR: ${sector} | PERIOD: ${year}

EMISSIONS DATA:
- Scope 1 (Natural Gas): ${em.scope1_gas||'Not submitted'} tCO₂e
- Scope 1 (Fleet): ${em.scope1_fleet||'Not submitted'} tCO₂e
- Scope 2 (Electricity): ${em.scope2_elec||'Not submitted'} tCO₂e
- Scope 3 (Travel): ${em.scope3_travel||'Not submitted'} tCO₂e
- Scope 3 (Supply Chain): ${em.scope3_supply||'Not submitted'} tCO₂e
- Renewable Energy: ${em.elec_renewable||'Not submitted'}%
- Net-Zero Target: ${em.netzero_year||'Not set'}

WATER & WASTE:
- Total Water Withdrawal: ${[em.water_surface,em.water_ground,em.water_municipal].filter(Boolean).reduce((a,b)=>a+ +b,0)||w.water_total||'Not submitted'} ML
- Water Recycled: ${w.water_recycled||'Not submitted'} ML
- Total Waste: ${w.waste_total||'Not submitted'} tonnes | Recycled: ${w.waste_recycled||'Not submitted'} t | Landfill: ${w.waste_landfill||'Not submitted'} t

SOCIAL:
- Headcount: ${s.headcount_total||'Not submitted'} (Perm: ${s.headcount_perm||'--'} | Contract: ${s.headcount_contract||'--'})
- Women (Total): ${s.women_total||'Not submitted'}% | Senior: ${s.women_senior||'Not submitted'}% | Board: ${s.women_board||'Not submitted'}%
- Pay Equity (F:M): Entry ${s.pay_entry||'--'} | Mid ${s.pay_mid||'--'} | Senior ${s.pay_senior||'--'}
- Training: ${s.training_hrs||'--'} hrs/emp | Attrition: ${s.attrition||'--'}% | LTIFR: ${s.ltifr||'--'}

GOVERNANCE:
- Board Independence: ${g.board_independence||'Not submitted'}% | ESG Committee: ${g.esg_committee||'Not submitted'}
- Whistleblower: ${g.whistle_cases||'--'} cases filed, ${g.whistle_resolved||'--'} resolved
- CSR Spend: ₹${g.csr_spend||'--'} Cr (${g.csr_pct||'--'}% of net profit)
- Revenue: ₹${g.revenue||'--'} Cr

SUPPLY CHAIN:
- Total Suppliers: ${g.suppliers_total||'Not submitted'} | ESG Assessed: ${g.suppliers_assessed||'--'} | High Risk: ${g.suppliers_high_risk||'--'}
`;

    const frameworkInstructions = {
      BRSR:`Structure as SEBI BRSR format:
SECTION A: General Disclosures
SECTION B: Management & Process Disclosures (all 9 Principles P1-P9)
SECTION C: Principle-wise Performance (Essential + Leadership indicators)
BRSR Core KPIs with year-on-year where available
Include SEBI filing notes and materiality assessment.`,
      GRI:`Structure as GRI Standards:
- GRI 2: General Disclosures | GRI 302: Energy | GRI 303: Water
- GRI 305: Emissions | GRI 306: Waste | GRI 401: Employment
- GRI 405: Diversity | GRI 414: Supplier Social Assessment
Include GRI Content Index, management approach, boundaries, omissions.`,
      SASB:`Structure as SASB ${sector} sector:
- Activity Metrics | Environmental | Social Capital | Human Capital
Use SASB metric codes (CG-AA prefix), measurement units, methodology.
Flag material topics for ${sector} industry.`,
      TCFD:`Structure across TCFD 4 pillars:
1. GOVERNANCE: Board oversight, management role, ESG committee
2. STRATEGY: Climate risks & opportunities, scenario analysis (1.5°C/2°C/4°C)
3. RISK MANAGEMENT: Identification, assessment, ERM integration
4. METRICS & TARGETS: GHG targets, net-zero pathway, executive compensation
Include Indian regulatory context (SEBI ESG, RBI climate risk).`
    };

    const prompt = `${dataBlock}

FRAMEWORK: ${fw}
${frameworkInstructions[fw]}

Write the complete report section. If data shows "Not submitted", note it as "Data pending submission" and recommend the disclosure. Include 2030/2050 SBTi-aligned targets. Use formal ESG disclosure language suitable for statutory auditor review.`;

    const PROXY = 'https://sustainiq-proxy.nirav4uall.workers.dev';

    try {
      const res = await fetch(PROXY, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:1000, system:systemPrompt, messages:[{role:'user',content:prompt}] })
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`API error ${res.status}: ${errText.slice(0,200)}`);
      }
      const data = await res.json();
      const text = data.content?.map(b=>b.text||'').join('')||'Error generating report.';
      setOutput(text);
      ReportsService.save(org.id, user.id, fw, text, {sector,year,fw});
      Billing.incrementAiUsage(org.id);
      addToast({msg:`${fw} report generated & saved`,type:'ok',icon:'✦'});
    } catch(e) {
      const msg = e.message?.includes('Failed to fetch')
        ? 'CORS error: AI proxy not configured. See DEPLOY.txt for Cloudflare Worker setup.'
        : `Error: ${e.message}`;
      setOutput('⚠ ' + msg + '\n\nThe rest of the platform works fully. Set up the proxy to enable AI reports.');
      addToast({msg:'AI report unavailable - proxy needed',type:'err',icon:'⚠'});
    }
    setLoading(false);
  }

  const used = org.aiReportsUsed || 0;
  const limit = PLANS_CONFIG[org.plan]?.aiLimit || 10;

  return (
    <div className="fu">
      <div className="card-xl">
        <div className="card-head">
          <div><div className="card-title">✦ AI Compliance Report Generator</div><div className="card-sub">Powered by Claude . Select framework . Generate audit-ready report from your live data</div></div>
          <div style={{fontSize:11,fontFamily:"'Azeret Mono',monospace",color:'var(--ink3)'}}>{used}/{limit==='999'?'∞':limit} reports used</div>
        </div>

        <div className="fw-grid">
          {FWS.map(f=>(
            <div key={f.id} className={`fw-opt${fw===f.id?' sel':''}`} style={{'--fo-c':f.c,'--fo-bg':f.bg}} onClick={()=>setFw(f.id)}>
              {f.isNew&&<div className="new-tag">INDIA FIRST</div>}
              <div className="fw-opt-id" style={{color:f.c}}>{f.id}</div>
              <div className="fw-opt-name">{f.name}</div>
              <div className="fw-opt-desc">{f.desc}</div>
            </div>
          ))}
        </div>

        <div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'flex-end',marginBottom:16}}>
          <div className="field" style={{marginBottom:0}}>
            <label>Company Name</label>
            <input type="text" value={org.name} disabled style={{background:'var(--bg)',width:200}}/>
          </div>
          <div className="field" style={{marginBottom:0}}>
            <label>Fiscal Year</label>
            <select value={year} onChange={e=>setYear(e.target.value)} style={{width:150}}>
              {['FY 2024-25','FY 2023-24','FY 2022-23'].map(y=><option key={y}>{y}</option>)}
            </select>
          </div>
          <div className="field" style={{marginBottom:0}}>
            <label>Sector</label>
            <select value={sector} onChange={e=>setSector(e.target.value)} style={{width:200}}>
              {['Apparel & Textile','Manufacturing','IT & Services','Financial Services','Healthcare','Energy & Utilities','Real Estate','FMCG','Automobiles'].map(s=><option key={s}>{s}</option>)}
            </select>
          </div>
          <button className={`btn btn-ink${loading?' btn-loading':''}`} onClick={generate} disabled={loading||!canGenerate} style={{alignSelf:'flex-end'}}>
            {loading?'Generating...':`✦ Generate ${fw} Report`}
          </button>
        </div>

        {!canGenerate&&<div style={{background:'var(--orange-bg)',border:'1px solid var(--orange-m)',borderRadius:'var(--r)',padding:'10px 14px',fontSize:12,color:'var(--orange)',marginBottom:12}}>⚠ You've reached the AI report limit for your plan. Upgrade to Growth for unlimited reports.</div>}

        {(loading||output)&&(
          <div className="ai-output-box">
            <div className="ai-output-hd">
              <div className="ai-tag"><span className="ai-dot"/>AI Generated . {fw} . {year} . {org.name}</div>
              <div style={{display:'flex',gap:8}}>
                {output&&<button className="btn btn-outline btn-sm" onClick={()=>navigator.clipboard.writeText(output).then(()=>addToast({msg:'Copied to clipboard',type:'ok'}))}>Copy</button>}
                {output&&<button className="btn btn-ghost btn-sm" onClick={()=>setOutput('')}>Clear</button>}
              </div>
            </div>
            {loading ? (
              <div className="spinner"><div className="spin-d"><span/><span/><span/></div><span style={{fontSize:12,color:'var(--ink3)'}}>Generating {fw} compliance report from your live ESG data...</span></div>
            ) : (
              <pre className="ai-text">{output}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════
   § 19  REPORT HISTORY
════════════════════════════════════════════════ */
function ReportHistPage() {
  const { org, addToast } = useApp();
  const [reports, setReports] = useState(() => ReportsService.getHistory(org.id));
  const [viewing, setViewing] = useState(null);

  function del(id) { ReportsService.delete(org.id,id); setReports(ReportsService.getHistory(org.id)); addToast({msg:'Report deleted',type:'ok'}); }

  if (!reports.length) return (
    <div className="card-xl"><div className="empty"><div className="empty-icon">📄</div><div style={{fontSize:16,fontWeight:700}}>No reports yet</div><p>Generate your first report from the Reports page</p></div></div>
  );

  return (
    <div className="fu">
      <div className="section-head"><div className="section-title">Report History ({reports.length})</div></div>
      {reports.map(r=>{
        const params = typeof r.params==='string'?JSON.parse(r.params||'{}'):r.params||{};
        const FW_COLORS = {BRSR:'#c2410c',GRI:'#176639',SASB:'#1a3fa8',TCFD:'#9a6f00'};
        return (
          <div key={r.id} className="report-hist-item" onClick={()=>setViewing(r)}>
            <div style={{width:36,height:36,borderRadius:'var(--r)',background:`${FW_COLORS[r.framework]}18`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,flexShrink:0}}>✦</div>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:700,marginBottom:2}}>{r.framework} Report -- {params.year||org.reportingYear}</div>
              <div style={{fontSize:11,color:'var(--ink3)',fontFamily:"'Azeret Mono',monospace"}}>{params.sector||org.industry} . {r.wordCount} words . {new Date(r.created_at).toLocaleDateString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
            </div>
            <Tag fw={r.framework}/>
            <button className="btn btn-outline btn-sm" onClick={e=>{e.stopPropagation();del(r.id)}} style={{fontSize:11}}>Delete</button>
          </div>
        );
      })}
      <Modal open={!!viewing} onClose={()=>setViewing(null)} title={`${viewing?.framework} Report -- ${JSON.parse(viewing?.params||'{}').year||''}`}
        footer={<><button className="btn btn-outline" onClick={()=>navigator.clipboard.writeText(viewing?.content||'').then(()=>addToast({msg:'Copied',type:'ok'}))}>Copy</button><button className="btn btn-ghost" onClick={()=>setViewing(null)}>Close</button></>}>
        <pre style={{fontFamily:"'Azeret Mono',monospace",fontSize:11.5,color:'var(--ink2)',whiteSpace:'pre-wrap',lineHeight:1.7,maxHeight:500,overflow:'auto'}}>{viewing?.content}</pre>
      </Modal>
    </div>
  );
}

/* ════════════════════════════════════════════════
   § 20  AUDIT TRAIL
════════════════════════════════════════════════ */
function AuditPage() {
  const { org } = useApp();
  const [log] = useState(() => DB.where('audit_log', l => l.orgId === org.id).reverse());
  const TYPE_ICONS = { auth:'🔑', data_entry:'✎', workflow:'☑', billing:'💳', team:'👥', default:'◆' };
  const members = TeamService.getMembers(org.id);
  const getName = id => { const m = members.find(m=>m.id===id); return m?`${m.firstName} ${m.lastName}`:'User'; };

  return (
    <div className="fu">
      <div className="kpi-grid" style={{gridTemplateColumns:'repeat(4,1fr)'}}>
        {[{l:'Total Entries',v:log.length},{l:'Data Updates',v:log.filter(l=>l.type==='data_entry').length},{l:'Workflow Events',v:log.filter(l=>l.type==='workflow').length},{l:'Billing Events',v:log.filter(l=>l.type==='billing').length}].map(k=>(
          <div key={k.l} className="kpi"><div className="kpi-label">{k.l}</div><div className="kpi-val">{k.v}</div></div>
        ))}
      </div>
      <div className="card-lg">
        <div className="card-head">
          <div className="card-title">Activity Log -- Immutable Audit Trail</div>
          <button className="btn btn-outline btn-sm">Export for Auditor</button>
        </div>
        {log.length===0&&<div className="empty"><div className="empty-icon">📋</div><p>No audit entries yet. Actions will appear here.</p></div>}
        {log.map((entry,i)=>{
          const meta = typeof entry.meta==='string'?JSON.parse(entry.meta||'{}'):entry.meta||{};
          return (
            <div key={entry.id} className="audit-item">
              {i<log.length-1&&<div className="audit-line"/>}
              <div className="audit-avatar">{getName(entry.userId).split(' ').map(n=>n[0]).join('')}</div>
              <div className="audit-body" style={{flex:1}}>
                <div className="audit-action"><strong>{getName(entry.userId)}</strong> -- {entry.action}</div>
                <div className="audit-meta">
                  <span>{new Date(entry.timestamp).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</span>
                  <span className={`pill p-${entry.type==='data_entry'?'green':entry.type==='billing'?'blue':entry.type==='workflow'?'amber':'ink'}`}>{entry.type?.toUpperCase().replace('_',' ')}</span>
                  {meta.changes?.slice(0,2).map((c,ci)=><span key={ci} className="audit-change">{c.split(' -> ')[0]?.split(': ')[0]}</span>)}
                  {meta.orderId&&<span className="audit-change">{meta.orderId}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════
   § 21  TEAM PAGE
════════════════════════════════════════════════ */
function TeamPage() {
  const { org, user, addToast } = useApp();
  const [members, setMembers] = useState(() => TeamService.getMembers(org.id));
  const [showInvite, setShowInvite] = useState(false);
  const [inv, setInv] = useState({email:'',firstName:'',lastName:'',role:'contributor'});
  const [invResult, setInvResult] = useState(null);

  function invite() {
    if (!inv.email.includes('@')||!inv.firstName.trim()) return;
    const r = TeamService.inviteUser(org.id, user.id, inv);
    if (r.error) { addToast({msg:r.error,type:'err'}); return; }
    setInvResult(r);
    setMembers(TeamService.getMembers(org.id));
    addToast({msg:`${inv.firstName} invited successfully`,type:'ok'});
  }

  const ROLES = { admin:'Admin',manager:'Manager',contributor:'Contributor',viewer:'Viewer' };
  const ROLE_DESC = { admin:'Full access including billing and settings',manager:'Can assign tasks, review and approve data',contributor:'Can enter and submit data for assigned modules',viewer:'Read-only access to dashboard and reports' };

  return (
    <div className="fu">
      <div className="section-head">
        <div className="section-title">Team Members ({members.length})</div>
        <button className="btn btn-ink btn-sm" onClick={()=>{setShowInvite(true);setInvResult(null)}}>+ Invite Member</button>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last Login</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {members.map(m=>(
              <tr key={m.id}>
                <td><div style={{display:'flex',alignItems:'center',gap:8}}><Avatar name={`${m.firstName} ${m.lastName}`}/><div><div style={{fontWeight:600,fontSize:13}}>{m.firstName} {m.lastName}</div>{m.tempPassword&&<div style={{fontSize:9,fontFamily:"'Azeret Mono',monospace",color:'var(--orange)'}}>TEMP PASS: {m.tempPassword}</div>}</div></div></td>
                <td style={{fontSize:12,color:'var(--ink3)'}}>{m.email}</td>
                <td><Pill label={ROLES[m.role]||m.role} color={m.role==='admin'?'violet':m.role==='manager'?'blue':m.role==='contributor'?'green':'ink'}/></td>
                <td style={{fontSize:11,color:'var(--ink4)',fontFamily:"'Azeret Mono',monospace"}}>{m.lastLogin?new Date(m.lastLogin).toLocaleDateString('en-IN'):'Never'}</td>
                <td><Pill label={m.isActive?'Active':'Inactive'} color={m.isActive?'green':'red'}/></td>
                <td>
                  {m.id!==user.id&&<div style={{display:'flex',gap:4}}>
                    <select className="fsel" style={{fontSize:11,padding:'4px 8px'}} value={m.role} onChange={e=>{TeamService.updateRole(org.id,user.id,m.id,e.target.value);setMembers(TeamService.getMembers(org.id));addToast({msg:'Role updated',type:'ok'})}}>
                      {Object.entries(ROLES).map(([k,v])=><option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>}
                  {m.id===user.id&&<span style={{fontSize:11,color:'var(--ink4)'}}>You</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card-lg">
        <div className="card-title" style={{marginBottom:14}}>Role Permissions</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:12}}>
          {Object.entries(ROLES).map(([k,v])=>(
            <div key={k} style={{border:'1px solid var(--border)',borderRadius:'var(--r)',padding:'14px 16px'}}>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}><Pill label={v} color={k==='admin'?'violet':k==='manager'?'blue':k==='contributor'?'green':'ink'}/></div>
              <div style={{fontSize:12,color:'var(--ink3)'}}>{ROLE_DESC[k]}</div>
            </div>
          ))}
        </div>
      </div>

      <Modal open={showInvite} onClose={()=>setShowInvite(false)} title="Invite Team Member"
        footer={invResult?<button className="btn btn-green" onClick={()=>setShowInvite(false)}>Done</button>:<><button className="btn btn-ghost" onClick={()=>setShowInvite(false)}>Cancel</button><button className="btn btn-ink" onClick={invite}>Send Invite</button></>}>
        {invResult ? (
          <div>
            <div style={{background:'var(--green-bg)',border:'1px solid var(--green-m)',borderRadius:'var(--r)',padding:14,marginBottom:14}}>
              <div style={{fontWeight:700,color:'var(--green)',marginBottom:4}}>✓ {inv.firstName} invited successfully!</div>
              <div style={{fontSize:12,color:'var(--ink3)'}}>Share these credentials:</div>
              <div style={{fontFamily:"'Azeret Mono',monospace",fontSize:12,marginTop:8}}>Email: {inv.email}<br/>Temp Password: <strong>{invResult.tempPassword}</strong></div>
            </div>
          </div>
        ) : <>
          <div className="field-row" style={{marginBottom:14}}>
            <div className="field" style={{marginBottom:0}}><label>First Name *</label><input value={inv.firstName} onChange={e=>setInv(p=>({...p,firstName:e.target.value}))} placeholder="Priya"/></div>
            <div className="field" style={{marginBottom:0}}><label>Last Name</label><input value={inv.lastName} onChange={e=>setInv(p=>({...p,lastName:e.target.value}))} placeholder="Sharma"/></div>
          </div>
          <div className="field"><label>Work Email *</label><input type="email" value={inv.email} onChange={e=>setInv(p=>({...p,email:e.target.value}))} placeholder="priya@company.in"/></div>
          <div className="field"><label>Role</label>
            <select value={inv.role} onChange={e=>setInv(p=>({...p,role:e.target.value}))}>
              {Object.entries(ROLES).map(([k,v])=><option key={k} value={k}>{v} -- {ROLE_DESC[k]}</option>)}
            </select>
          </div>
        </>}
      </Modal>
    </div>
  );
}

/* ════════════════════════════════════════════════
   § 22  BILLING PAGE
════════════════════════════════════════════════ */
function BillingPage({ onUpgrade }) {
  const { org, user, addToast } = useApp();
  const invoices = Billing.getInvoices(org.id);
  const plan = PLANS_CONFIG[org.plan] || PLANS_CONFIG.starter;
  const isTrial = org.subscriptionStatus === 'trial';
  const used = org.aiReportsUsed || 0;

  function cancel() {
    if (!window.confirm('Cancel subscription? You can re-subscribe anytime.')) return;
    Billing.cancelSubscription(org.id, user.id);
    addToast({msg:'Subscription cancelled',type:'warn',icon:'⚠'});
  }

  return (
    <div className="fu">
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:20}}>
        <div className="card-lg">
          <div className="card-title" style={{marginBottom:12}}>Current Plan</div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12}}>
            <div>
              <div style={{fontFamily:"'DM Serif Display',serif",fontSize:28,fontWeight:400,marginBottom:4}}>{plan.name}</div>
              <div style={{fontSize:12,color:'var(--ink3)',marginBottom:10}}>{isTrial?`Free trial -- ${Math.max(0,Math.ceil((new Date(org.trialEnds)-Date.now())/86400000))} days left`:org.billingCycle==='annual'?'Billed annually':'Billed monthly'}</div>
              <Pill label={org.subscriptionStatus?.toUpperCase()||'TRIAL'} color={org.subscriptionStatus==='active'?'green':org.subscriptionStatus==='trial'?'amber':'red'}/>
            </div>
            <div style={{textAlign:'right'}}>
              {org.nextBillingDate&&<div style={{fontSize:11,color:'var(--ink4)',fontFamily:"'Azeret Mono',monospace"}}>Next billing<br/>{new Date(org.nextBillingDate).toLocaleDateString('en-IN')}</div>}
            </div>
          </div>
          <div className="divider"/>
          <div style={{fontSize:12,color:'var(--ink3)',marginBottom:12}}>AI Reports: {used} / {plan.aiLimit===999?'Unlimited':plan.aiLimit} used this period</div>
          <div className="progress-bar"><div className="progress-fill" style={{width:`${plan.aiLimit===999?30:(used/plan.aiLimit)*100}%`,background:'var(--green)'}}/></div>
          <div style={{display:'flex',gap:8,marginTop:16}}>
            {isTrial&&<button className="btn btn-orange" onClick={onUpgrade}>Upgrade Plan</button>}
            {!isTrial&&org.subscriptionStatus==='active'&&<button className="btn btn-outline btn-sm" onClick={cancel}>Cancel Subscription</button>}
          </div>
        </div>
        <div className="card-lg">
          <div className="card-title" style={{marginBottom:12}}>Plan Features</div>
          <ul style={{listStyle:'none',display:'flex',flexDirection:'column',gap:7}}>
            {plan.features.map(f=><li key={f} style={{fontSize:13,display:'flex',gap:8,alignItems:'flex-start'}}><span style={{color:'var(--green)',fontWeight:700,flexShrink:0}}>✓</span>{f}</li>)}
          </ul>
          {PLAN_LIST.filter(p=>p.id!==org.plan&&p.id!=='enterprise').map(p=>(
            <div key={p.id} style={{marginTop:12,padding:'10px 14px',background:'var(--bg2)',borderRadius:'var(--r)',border:'1px solid var(--border)'}}>
              <div style={{fontSize:12,fontWeight:700,marginBottom:4}}>Upgrade to {p.name} -></div>
              <div style={{fontSize:11,color:'var(--ink3)',marginBottom:8}}>{p.features.filter(f=>!plan.features.includes(f)).slice(0,3).join(' . ')}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="tbl-wrap">
        <div className="tbl-toolbar"><div className="tbl-title">Invoice History</div></div>
        {invoices.length===0 ? (
          <div className="empty" style={{padding:32}}><p>No invoices yet. Invoices appear here after payment.</p></div>
        ) : (
          <table>
            <thead><tr><th>Order ID</th><th>Plan</th><th>Amount</th><th>GST</th><th>Total</th><th>Date</th><th>Status</th><th>Invoice</th></tr></thead>
            <tbody>
              {invoices.map(inv=>(
                <tr key={inv.id}>
                  <td style={{fontFamily:"'Azeret Mono',monospace",fontSize:12}}>{inv.orderId}</td>
                  <td><Pill label={inv.plan?.toUpperCase()} color="blue"/></td>
                  <td style={{fontFamily:"'Azeret Mono',monospace",fontSize:12}}>₹{(inv.amount||0).toLocaleString('en-IN')}</td>
                  <td style={{fontFamily:"'Azeret Mono',monospace",fontSize:12}}>₹{(inv.gst||0).toLocaleString('en-IN')}</td>
                  <td style={{fontFamily:"'Azeret Mono',monospace",fontSize:12,fontWeight:700}}>₹{(inv.total||0).toLocaleString('en-IN')}</td>
                  <td style={{fontSize:11,color:'var(--ink3)'}}>{new Date(inv.paidAt||inv.created_at).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}</td>
                  <td><Pill label="PAID" color="green"/></td>
                  <td><button className="btn btn-ghost btn-sm" style={{fontSize:11}} onClick={()=>addToast({msg:'Invoice PDF download (production feature)',type:'ok'})}>PDF ↓</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════
   § 23  SETTINGS PAGE
════════════════════════════════════════════════ */
function SettingsPage() {
  const { org, user, addToast } = useApp();
  const [tab, setTab] = useState('org');
  const [orgForm, setOrgForm] = useState({name:org.name||'',cin:org.cin||'',industry:org.industry||'Apparel & Textile',reportingYear:org.reportingYear||'FY 2024-25',gstin:org.gstin||''});
  const [pwForm, setPwForm] = useState({current:'',newPw:'',confirm:''});

  function saveOrg() { DB.update('orgs', org.id, orgForm); addToast({msg:'Organisation settings saved',type:'ok'}); }
  function savePw() {
    if (user.passwordHash !== hash(pwForm.current)) { addToast({msg:'Current password incorrect',type:'err'}); return; }
    if (pwForm.newPw.length<6) { addToast({msg:'New password must be 6+ chars',type:'err'}); return; }
    if (pwForm.newPw!==pwForm.confirm) { addToast({msg:"Passwords don't match",type:'err'}); return; }
    DB.update('users', user.id, {passwordHash:hash(pwForm.newPw)});
    addToast({msg:'Password updated successfully',type:'ok'});
    setPwForm({current:'',newPw:'',confirm:''});
  }

  const SETTINGS_TABS = [{id:'org',ic:'🏢',lbl:'Organisation'},{id:'profile',ic:'👤',lbl:'My Profile'},{id:'security',ic:'🔒',lbl:'Security'},{id:'integrations',ic:'🔗',lbl:'Integrations'},{id:'data',ic:'🗄',lbl:'Data & Export'}];

  return (
    <div className="fu">
      <div className="settings-layout">
        <div className="settings-nav">
          {SETTINGS_TABS.map(t=>(
            <div key={t.id} className={`settings-nav-item${tab===t.id?' active':''}`} onClick={()=>setTab(t.id)}>
              <span>{t.ic}</span>{t.lbl}
            </div>
          ))}
        </div>
        <div>
          {tab==='org'&&<div className="card-xl">
            <div className="card-title" style={{marginBottom:4}}>Organisation Settings</div>
            <div style={{fontSize:12,color:'var(--ink3)',marginBottom:20}}>These details appear in generated reports and invoices.</div>
            <div className="field-row"><div className="field" style={{marginBottom:14}}><label>Company Legal Name</label><input value={orgForm.name} onChange={e=>setOrgForm(p=>({...p,name:e.target.value}))}/></div><div className="field" style={{marginBottom:14}}><label>CIN Number</label><input value={orgForm.cin} onChange={e=>setOrgForm(p=>({...p,cin:e.target.value}))} placeholder="L17110MH1945PLC004520"/></div></div>
            <div className="field-row"><div className="field" style={{marginBottom:14}}><label>Industry Sector</label><select value={orgForm.industry} onChange={e=>setOrgForm(p=>({...p,industry:e.target.value}))}>{['Apparel & Textile','Manufacturing','IT & Services','Financial Services','Healthcare','Energy & Utilities','Real Estate','FMCG','Automobiles'].map(s=><option key={s}>{s}</option>)}</select></div><div className="field" style={{marginBottom:14}}><label>Reporting Year</label><select value={orgForm.reportingYear} onChange={e=>setOrgForm(p=>({...p,reportingYear:e.target.value}))}>{['FY 2024-25','FY 2023-24','FY 2022-23'].map(y=><option key={y}>{y}</option>)}</select></div></div>
            <div className="field" style={{marginBottom:14}}><label>GSTIN</label><input value={orgForm.gstin} onChange={e=>setOrgForm(p=>({...p,gstin:e.target.value.toUpperCase()}))} placeholder="27AABCU9603R1ZX"/></div>
            <button className="btn btn-ink" onClick={saveOrg}>Save Changes</button>
          </div>}

          {tab==='profile'&&<div className="card-xl">
            <div className="card-title" style={{marginBottom:20}}>My Profile</div>
            <div className="field-row"><div className="field" style={{marginBottom:14}}><label>First Name</label><input defaultValue={user.firstName}/></div><div className="field" style={{marginBottom:14}}><label>Last Name</label><input defaultValue={user.lastName}/></div></div>
            <div className="field" style={{marginBottom:14}}><label>Email</label><input value={user.email} disabled style={{background:'var(--bg)'}}/></div>
            <div className="field" style={{marginBottom:14}}><label>Role</label><input value={user.role} disabled style={{background:'var(--bg)'}}/></div>
            <button className="btn btn-ink" onClick={()=>addToast({msg:'Profile updated',type:'ok'})}>Save Profile</button>
          </div>}

          {tab==='security'&&<div className="card-xl">
            <div className="card-title" style={{marginBottom:20}}>Change Password</div>
            <div className="field" style={{marginBottom:14}}><label>Current Password</label><input type="password" value={pwForm.current} onChange={e=>setPwForm(p=>({...p,current:e.target.value}))}/></div>
            <div className="field" style={{marginBottom:14}}><label>New Password (min 6 chars)</label><input type="password" value={pwForm.newPw} onChange={e=>setPwForm(p=>({...p,newPw:e.target.value}))}/></div>
            <div className="field" style={{marginBottom:14}}><label>Confirm New Password</label><input type="password" value={pwForm.confirm} onChange={e=>setPwForm(p=>({...p,confirm:e.target.value}))}/></div>
            <button className="btn btn-ink" onClick={savePw}>Update Password</button>
          </div>}

          {tab==='integrations'&&<div className="card-xl">
            <div className="card-title" style={{marginBottom:6}}>Integrations</div>
            <div style={{fontSize:12,color:'var(--ink3)',marginBottom:20}}>Connect your existing systems to auto-import ESG data</div>
            {[{name:'SAP / Oracle ERP',desc:'Import energy costs, production volumes, procurement spend',status:'available'},{name:'Tally Prime',desc:'Indian accounting data for CSR spend and revenue metrics',status:'available'},{name:'Darwinbox / Workday HRMS',desc:'Headcount, diversity, payroll for pay equity metrics',status:'available'},{name:'Concur Travel',desc:'Business travel for Scope 3 emissions calculation',status:'coming'},{name:'Razorpay',desc:'Payment processing for subscription management',status:'connected'}].map(int=>(
              <div key={int.name} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 0',borderBottom:'1px solid var(--border)'}}>
                <div style={{flex:1}}><div style={{fontSize:13,fontWeight:600}}>{int.name}</div><div style={{fontSize:11,color:'var(--ink3)',marginTop:2}}>{int.desc}</div></div>
                <button className={`btn btn-sm ${int.status==='connected'?'btn-green':int.status==='coming'?'btn-ghost':'btn-outline'}`} style={{marginLeft:12}} onClick={()=>int.status==='available'&&addToast({msg:`${int.name} -- full integration available in production build`,type:'ok'})}>
                  {int.status==='connected'?'✓ Connected':int.status==='coming'?'Coming Soon':'Connect'}
                </button>
              </div>
            ))}
          </div>}

          {tab==='data'&&<div className="card-xl">
            <div className="card-title" style={{marginBottom:20}}>Data Management</div>
            {[['Export All ESG Data','Download complete ESG data as Excel workbook','Export CSV'],['Export Audit Log','Download full audit trail for verifier submission','Export PDF'],['Export Report History','All AI-generated reports as PDF bundle','Export Bundle'],['Delete Account Data','Permanently delete all organisation data','Danger Zone']].map(([t,d,b],i)=>(
              <div key={t} style={{display:'flex',alignItems:'center',padding:'14px 0',borderBottom:'1px solid var(--border)',gap:12}}>
                <div style={{flex:1}}><div style={{fontSize:13,fontWeight:600}}>{t}</div><div style={{fontSize:11,color:'var(--ink3)',marginTop:2}}>{d}</div></div>
                <button className={`btn btn-sm ${i===3?'btn-red':'btn-outline'}`} onClick={()=>addToast({msg:i===3?'Contact support to delete account':'Export ready in production',type:i===3?'err':'ok'})}>{b}</button>
              </div>
            ))}
          </div>}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════
   § 24  NOTIFICATIONS PANEL
════════════════════════════════════════════════ */
function NotifPanel({ notifs, onClose }) {
  const { org } = useApp();
  function markRead(id) { DB.update('notifications', id, {read:true}); }
  return (
    <div className="notif-panel">
      <div className="notif-header">
        <div style={{fontWeight:700,fontSize:14}}>Notifications</div>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>x</button>
      </div>
      <div className="notif-list-wrap">
        {notifs.length===0&&<div className="empty"><div className="empty-icon">🔔</div><p>No notifications yet</p></div>}
        {notifs.map(n=>(
          <div key={n.id} className={`notif-item${!n.read?' unread':''}`} onClick={()=>markRead(n.id)}>
            <div className="notif-icon">📢</div>
            <div className="notif-body">
              <div className="notif-title">{n.message}</div>
              <div className="notif-time">{new Date(n.timestamp).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
            </div>
            {!n.read&&<div style={{width:7,height:7,background:'var(--blue)',borderRadius:'50%',flexShrink:0,marginTop:4}}/>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════
   § 25  ROOT APP
════════════════════════════════════════════════ */
export default function App() {
  const [view, setView]             = useState('landing');  // landing | auth | checkout | app
  const [authMode, setAuthMode]     = useState('login');
  const [checkoutPlan, setCP]       = useState('growth');
  const [session, setSession]       = useState(() => Auth.session());
  const [toasts, setToasts]         = useState([]);

  useEffect(() => { if (session) setView('app'); }, []);

  function addToast(t) {
    const id = Date.now() + Math.random();
    setToasts(p => [...p, {...t, id}]);
    setTimeout(() => setToasts(p => p.filter(x => x.id !== id)), 3500);
  }

  function handleAuthSuccess(result) {
    setSession(result);
    setView('app');
    addToast({msg:`Welcome back, ${result.user.firstName}!`,type:'ok',icon:'👋'});
  }

  function handleCheckoutComplete() {
    const sess = Auth.session();
    setSession(sess);
    setView('app');
    addToast({msg:'Subscription active! Welcome to SustainIQ.',type:'ok',icon:'🎉'});
  }

  function logout() {
    Auth.logout();
    setSession(null);
    setView('landing');
    addToast({msg:'Signed out successfully',type:'ok'});
  }

  function handleGetStarted(planId) {
    setCP(planId);
    if (session) { setView('checkout'); }
    else { setAuthMode('register'); setView('auth'); }
  }

  if (!session && view === 'app') { setView('landing'); }

  return (
    <>
      <style>{CSS}</style>

      <AppCtx.Provider value={{ user: session?.user, org: DB.getOne('orgs', session?.org?.id || session?.org?.orgId) || session?.org, addToast, logout, refreshSession: ()=>setSession(Auth.session()) }}>
        {view==='landing' && <LandingPage onAuth={(m)=>{setAuthMode(m);setView('auth')}} onGetStarted={handleGetStarted}/>}
        {view==='auth'    && <AuthPage mode={authMode} onSuccess={r=>{if(authMode==='register'){setSession(r);setView('checkout');}else{handleAuthSuccess(r);}}} onSwitch={m=>{setAuthMode(m)}}/>}
        {view==='checkout'&& <CheckoutFlow planId={checkoutPlan} onBack={()=>setView(session?'app':'landing')} onComplete={handleCheckoutComplete} existingAuth={session}/>}
        {view==='app' && session && <AppShell/>}
      </AppCtx.Provider>

      <Toast toasts={toasts}/>
    </>
  );
}

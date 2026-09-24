import { digest } from './cloud-crypto.js';
import pool from '../../config/database.js';
import { ServiceUnavailableError } from '../errors/app-error.js';

export function safeSegment(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Empty storage path segment.');
  const clean = input.normalize('NFKC').replace(/[^A-Za-z0-9 _-]/g,'_').trim().replace(/\s+/g,' ').slice(0,64);
  if (!clean || /^_+$/.test(clean)) return `ref-${digest(input).slice(0,12)}`;
  const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(clean);
  return `${reserved?'ref-':''}${clean}${clean!==input?`-${digest(input).slice(0,8)}`:''}`;
}
export function folderPath({ namespace, category, identifier, site, year }) {
  const root = ['ESDMS',safeSegment(site || 'Company')];
  if (namespace === 'cms') return [...root,'Branding'];
  if (namespace === 'workforce') return [...root,'Workforce',safeSegment(identifier),category==='profile-photo'?'Profile Photos':category==='draft'?'Contracts':'Documents'];
  if (namespace === 'procurement') return [...root,category==='ipo'?'IPO':'Delivery Challan',String(year),safeSegment(identifier)];
  const categoryNames = {pdf:'Approval','completion-pdf':'Completion',departure:'Departure',return:'Return',additional:'Additional Evidence'};
  if (!categoryNames[category]) throw new ServiceUnavailableError('Unsupported storage category.');
  return [...root,'Gate Pass',String(year),safeSegment(identifier),categoryNames[category]];
}
export async function storageContext({gatePassId,category,cloudCategory,namespace='gate-pass'}) {
  let row;
  if (namespace === 'cms' && gatePassId === 'branding' && category === 'logo') return {namespace,category,identifier:'Branding',site:'Company',entityId:'branding',siteId:null};
  if (!/^[a-f0-9-]{36}$/i.test(gatePassId || '')) throw new ServiceUnavailableError('Invalid storage owner.');
  if (namespace === 'workforce') {
    row = (await pool.query(category==='draft'
      ? 'SELECT e.employee_code AS identifier,e.primary_site_id AS site_id,e.created_at,s.code AS site FROM employee_contracts c JOIN employees e ON e.id=c.employee_id JOIN sites s ON s.id=e.primary_site_id WHERE c.id=$1'
      : 'SELECT e.employee_code AS identifier,e.primary_site_id AS site_id,e.created_at,s.code AS site FROM employees e JOIN sites s ON s.id=e.primary_site_id WHERE e.id=$1',[gatePassId])).rows[0];
  } else if (namespace === 'procurement' && ['ipo','delivery-challan'].includes(category)) {
    const table = category==='ipo'?'ipos':'delivery_challans';
    const number = category==='ipo'?'ipo_number':'dc_number';
    row = (await pool.query(`SELECT d.${number} AS identifier,d.site_id,d.created_at,s.code AS site FROM ${table} d JOIN sites s ON s.id=d.site_id WHERE d.id=$1`,[gatePassId])).rows[0];
  } else if (namespace === 'gate-pass') {
    row = (await pool.query('SELECT g.gate_pass_number AS identifier,g.site_id,g.created_at,s.code AS site FROM gate_passes g JOIN sites s ON s.id=g.site_id WHERE g.id=$1',[gatePassId])).rows[0];
  }
  if (!row) throw new ServiceUnavailableError('Storage owner is unavailable.');
  return { namespace,category:cloudCategory || category,identifier:row.identifier,site:row.site,siteId:row.site_id,year:new Date(row.created_at).getUTCFullYear(),entityId:gatePassId };
}

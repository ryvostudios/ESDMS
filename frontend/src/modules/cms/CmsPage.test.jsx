import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { CmsPage } from './CmsPage.jsx';
import { ApplicationNotice } from './ApplicationNotice.jsx';
const state=vi.hoisted(()=>({permissions:new Set(),get:vi.fn(),patch:vi.fn(),put:vi.fn(),del:vi.fn(),getBlob:vi.fn()}));
vi.mock('../../core/auth/AuthContext.jsx',()=>({useAuth:()=>({user:{role:'CEO'},hasPermission:p=>state.permissions.has(p)})}));
vi.mock('../../core/api/client.js',()=>({apiClient:{get:state.get,patch:state.patch,put:state.put,del:state.del,getBlob:state.getBlob}}));
const mount=path=>render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/cms/:area?" element={<CmsPage/>}/></Routes></MemoryRouter>);
beforeEach(()=>{state.permissions=new Set();for(const fn of [state.get,state.patch,state.put,state.del,state.getBlob])fn.mockReset();state.getBlob.mockRejectedValue(new Error('none'));});
afterEach(cleanup);
describe('CMS area and content boundaries',()=>{
 test('only backend-approved areas appear; direct unapproved area does not fetch protected data',async()=>{
  state.get.mockResolvedValue({data:[{id:'users',label:'Users & Access'}]});
  mount('/cms');expect(await screen.findByRole('link',{name:/Open users & access/i})).toBeTruthy();expect(screen.queryByText('Branding')).toBeNull();
  cleanup();mount('/cms/branding');expect(await screen.findByText('Access denied')).toBeTruthy();expect(state.get.mock.calls.every(([url])=>url==='/cms')).toBe(true);
 });
 test('catalog uses human labels with immutable code secondary and no edit control for a viewer',async()=>{
  state.get.mockImplementation(url=>Promise.resolve({data:url==='/cms'?[{id:'permissions',label:'Permission Catalog'}]:[{code:'employees.view',display_name:'View Employee Records',description:'View records within permitted scope.',category:'Workforce',help_text:''}]}));
  mount('/cms/permissions');expect(await screen.findByText('View Employee Records')).toBeTruthy();expect(screen.getByText('Immutable code: employees.view')).toBeTruthy();expect(screen.queryByRole('button',{name:'Save metadata'})).toBeNull();
 });
 test('allowlisted text update sends revision and displays server validation failures',async()=>{
  const row={key:'login.heading',label:'Sign-in heading',description:'Public heading',value:'Sign in',revision:3,max:100,min:1};
  state.get.mockImplementation(url=>Promise.resolve({data:url==='/cms'?[{id:'content',label:'Application Content'}]:[row]}));
  state.patch.mockRejectedValue(new Error('Use plain text without markup.'));
  mount('/cms/content');const input=await screen.findByLabelText('Sign-in heading');fireEvent.change(input,{target:{value:'<script>alert(1)</script>'}});fireEvent.click(screen.getByRole('button',{name:'Save sign-in heading'}));
  expect(await screen.findByText('Use plain text without markup.')).toBeTruthy();expect(state.patch).toHaveBeenCalledWith('/cms/settings/login.heading',{value:'<script>alert(1)</script>',revision:3});
  expect(document.querySelector('script')).toBeNull();
 });
 test('public content is rendered as text even if a compromised response contains markup',async()=>{
  const payload='<img src=x onerror="window.cmsExecuted=true">';
  state.get.mockResolvedValue({data:{'dashboard.announcement':payload}});
  render(<ApplicationNotice/>);expect(await screen.findByText(payload)).toBeTruthy();expect(document.querySelector('img')).toBeNull();expect(window.cmsExecuted).toBeUndefined();
 });
 test('public content failure preserves defaults and does not interrupt the application',async()=>{
  state.get.mockRejectedValue(new Error('Unavailable'));render(<ApplicationNotice/>);await waitFor(()=>expect(state.get).toHaveBeenCalled());expect(document.querySelector('aside')).toBeNull();
 });

 test('branding logo: preview from the API, client-side type/size guard, upload sends revision, restore default',async()=>{
  const logoRow={key:'company.logo',label:'Company logo',description:'Logo printed on newly generated documents.',type:'logo',revision:4,logo:{source:'uploaded',description:'Uploaded PNG 353×402, 149 KB, sha256 abc'}};
  const nameRow={key:'document.company_name',label:'Document issuer name',description:'Printed on documents',value:'E-Set Engineering Services',revision:2,max:150,min:1};
  state.get.mockImplementation(url=>Promise.resolve({data:url==='/cms'?[{id:'branding',label:'Branding'}]:[nameRow,logoRow]}));
  state.getBlob.mockResolvedValue(new Blob(['png'],{type:'image/png'}));
  globalThis.URL.createObjectURL=vi.fn(()=>'blob:logo');globalThis.URL.revokeObjectURL=vi.fn();
  state.put.mockResolvedValue({data:{}});state.del.mockResolvedValue({data:{}});
  mount('/cms/branding');
  expect(await screen.findByAltText('Current company logo')).toBeTruthy();
  expect(screen.getByLabelText('Document issuer name')).toBeTruthy();
  const input=screen.getByLabelText(/Replace logo/);
  fireEvent.change(input,{target:{files:[new File(['<svg/>'],'logo.svg',{type:'image/svg+xml'})]}});
  expect(screen.getByText('Choose a PNG or JPEG image.')).toBeTruthy();
  expect(screen.getByRole('button',{name:'Upload logo'}).disabled).toBe(true);
  fireEvent.change(input,{target:{files:[new File([new Uint8Array(2*1024*1024+1)],'big.png',{type:'image/png'})]}});
  expect(screen.getByText('The logo must be 2 MB or smaller.')).toBeTruthy();
  const valid=new File(['png'],'logo.png',{type:'image/png'});
  fireEvent.change(input,{target:{files:[valid]}});
  fireEvent.click(screen.getByRole('button',{name:'Upload logo'}));
  await waitFor(()=>expect(state.put).toHaveBeenCalled());
  const [path,form,options]=state.put.mock.calls[0];
  expect(path).toBe('/cms/branding/logo');expect(options).toEqual({isForm:true});expect(form.get('revision')).toBe('4');expect(form.get('logo').name).toBe('logo.png');
  fireEvent.click(await screen.findByRole('button',{name:'Restore default E-Set logo'}));
  await waitFor(()=>expect(state.del).toHaveBeenCalledWith('/cms/branding/logo',{body:{revision:4}}));
 });
 test('branding logo unavailable: honest text fallback, no substitute image',async()=>{
  const logoRow={key:'company.logo',label:'Company logo',description:'d',type:'logo',revision:1,logo:{source:'default',description:'Default E-Set logo'}};
  state.get.mockImplementation(url=>Promise.resolve({data:url==='/cms'?[{id:'branding',label:'Branding'}]:[logoRow]}));
  mount('/cms/branding');
  expect(await screen.findByText(/Logo unavailable/)).toBeTruthy();
  expect(document.querySelector('img')).toBeNull();
  expect(screen.queryByRole('button',{name:'Restore default E-Set logo'})).toBeNull();
 });
});

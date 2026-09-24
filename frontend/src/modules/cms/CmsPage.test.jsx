import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { CmsPage } from './CmsPage.jsx';
import { ApplicationNotice } from './ApplicationNotice.jsx';
const state=vi.hoisted(()=>({permissions:new Set(),get:vi.fn(),patch:vi.fn()}));
vi.mock('../../core/auth/AuthContext.jsx',()=>({useAuth:()=>({user:{role:'CEO'},hasPermission:p=>state.permissions.has(p)})}));
vi.mock('../../core/api/client.js',()=>({apiClient:{get:state.get,patch:state.patch}}));
const mount=path=>render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/cms/:area?" element={<CmsPage/>}/></Routes></MemoryRouter>);
beforeEach(()=>{state.permissions=new Set();state.get.mockReset();state.patch.mockReset();});
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
});

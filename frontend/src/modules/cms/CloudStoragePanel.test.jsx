import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { afterEach,beforeEach,expect,test,vi } from 'vitest';
import { CloudStoragePanel } from './CloudStoragePanel.jsx';
const state=vi.hoisted(()=>({manage:true,get:vi.fn(),post:vi.fn()}));
vi.mock('../../core/auth/AuthContext.jsx',()=>({useAuth:()=>({hasPermission:()=>state.manage})}));
vi.mock('../../core/api/client.js',()=>({apiClient:{get:state.get,post:state.post}}));
const snapshot=()=>({activeProvider:'legacy',revision:2,providers:[{provider:'dropbox',status:'connected',setupComplete:true,account_label:'Test account',rootFolder:'ESDMS',dependent_files:1,revision:3},{provider:'google_drive',status:'disconnected',setupComplete:false,dependent_files:0,rootFolder:'ESDMS',revision:1}]});
beforeEach(()=>{state.manage=true;state.get.mockReset().mockResolvedValue({data:snapshot()});state.post.mockReset().mockResolvedValue({data:{}});});
afterEach(cleanup);
test('shows setup guidance and blocks disconnect of dependent files',async()=>{
  render(<CloudStoragePanel/>);expect(await screen.findByText('Provider setup incomplete')).toBeTruthy();
  expect(screen.getByRole('button',{name:'Connect Google Drive'}).disabled).toBe(true);
  expect(screen.getAllByRole('button',{name:'Disconnect'})[0].disabled).toBe(true);
  expect(screen.queryByText(/access_token|refresh_token|client_secret/)).toBeNull();
});
test('view authority never supplies management controls',async()=>{
  state.manage=false;render(<CloudStoragePanel/>);await screen.findByText('Test account',{exact:false});
  expect(screen.queryByRole('button')).toBeNull();
});
test('activation is explicit and uses the latest revision; server refusals remain visible',async()=>{
  state.post.mockRejectedValue(new Error('Connection changed. Reload before saving.'));
  render(<CloudStoragePanel/>);fireEvent.click(await screen.findByRole('button',{name:'Use Dropbox for new files'}));
  expect(await screen.findByText('Connection changed. Reload before saving.')).toBeTruthy();
  expect(state.post).toHaveBeenCalledWith('/cms/cloud-storage/active',{provider:'dropbox',revision:2});
});

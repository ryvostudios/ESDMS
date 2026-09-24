import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../shared/authorization/require-permission.js';
import { asyncHandler } from '../../shared/http/async-handler.js';
import { cloudConfig } from '../../shared/storage/cloud-config.js';
import { parse } from './cms.service.js';
import * as service from './cloud-storage.service.js';
const router=Router();
const revision=z.object({revision:z.number().int().positive()}).strict();
const manage=requirePermission('cms.integrations.manage');
router.use((_req,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});next();});
const reply=fn=>asyncHandler(async(req,res)=>res.json({success:true,data:await fn(req)}));
router.get('/',requirePermission('cms.integrations.view','cms.integrations.manage'),reply(()=>service.status()));
router.post('/active',manage,reply(req=>{
  const input=parse(revision.extend({provider:z.enum(['legacy','dropbox','google_drive'])}),req.body);
  return service.activate(req.user,input.provider,input.revision);
}));
router.post('/:provider/connect',manage,reply(req=>service.initiate(req,req.params.provider)));
router.get('/:provider/callback',manage,asyncHandler(async(req,res)=>{
  await service.callback(req,req.params.provider);
  res.redirect(303,`${cloudConfig().origin}/cms/integrations?cloud=connected`);
}));
router.post('/:provider/test',manage,reply(req=>service.testConnection(req.user,req.params.provider)));
router.post('/:provider/cleanup',manage,reply(req=>service.cleanup(req.user,req.params.provider)));
router.post('/:provider/disconnect',manage,reply(req=>service.disconnect(req.user,req.params.provider,parse(revision,req.body).revision)));
export default router;

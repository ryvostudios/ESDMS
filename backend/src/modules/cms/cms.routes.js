import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../shared/authorization/require-permission.js';
import { asyncHandler } from '../../shared/http/async-handler.js';
import { employeeSiteFilter } from '../workforce/workforce.authorization.js';
import { AREAS } from './cms.config.js';
import { metadataSchema,auditQuerySchema } from './cms.validation.js';
import * as service from './cms.service.js';
import * as repo from './cms.repository.js';
import { logoUpload, extractLogo } from './branding.upload.js';
const router = Router();
const reply = fn => asyncHandler(async(req,res)=>{res.set('Cache-Control','no-store');res.json({success:true,data:await fn(req)});});
// Only explicitly public plain-text content is returned, never configuration credentials.
router.get('/public-content',reply(()=>service.publicContent()));
// The company logo is public artwork, served only in its validated raster type.
router.get('/branding/logo',asyncHandler(async(req,res)=>{
  const logo=await service.activeLogo();
  res.set({'Cache-Control':'no-cache','ETag':`"${logo.etag}"`,'Content-Disposition':'inline; filename="company-logo"'});
  if(req.fresh) return res.status(304).end();
  res.type(logo.mimeType).send(logo.buffer);
}));
router.use(authenticate);
router.get('/',requirePermission(...AREAS.flatMap(a=>a.permissions)),reply(req=>AREAS.filter(a=>a.permissions.some(p=>req.user.permissions.has(p))).map(({id,label})=>({id,label}))));
router.get('/sites',requirePermission('departments.manage','positions.manage'),reply(req=>repo.sites(employeeSiteFilter(req.user))));
router.get('/permissions',requirePermission('cms.permissions.view','cms.permissions.manage'),reply(()=>repo.permissions()));
router.patch('/permissions/:code',requirePermission('cms.permissions.manage'),reply(req=>service.updatePermission(req.user,req.params.code,service.parse(metadataSchema,req.body))));
for (const category of ['branding','content']) router.get(`/settings/${category}`,requirePermission(`cms.${category}.manage`),reply(()=>service.listSettings(category)));
router.patch('/settings/:key',requirePermission('cms.branding.manage','cms.content.manage'),reply(req=>service.updateSetting(req.user,req.params.key,req.body)));
router.put('/branding/logo',requirePermission('cms.branding.manage'),logoUpload,reply(req=>service.replaceLogo(req.user,req.body,extractLogo(req))));
router.delete('/branding/logo',requirePermission('cms.branding.manage'),reply(req=>service.resetLogo(req.user,req.body)));
router.get('/integrations',requirePermission('cms.integrations.view'),reply(()=>service.integrations()));
router.get('/audit',requirePermission('cms.audit.view'),reply(req=>service.audit(req.user,service.parse(auditQuerySchema,req.query))));
router.get('/system',requirePermission('cms.system.view'),reply(()=>service.systemInfo()));
export default router;

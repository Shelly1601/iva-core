import express from 'express';
import { createProjectMarketingService } from './project-service.js';

export function registerProjectMarketingRoutes(app, options) {
  const service = options.service || createProjectMarketingService(options);
  const route = action => async (req, res) => {
    try {
      if (req.params.projectId && options.authorizeProject) await options.authorizeProject(req.params.projectId, req);
      res.set('Cache-Control', 'no-store');
      await action(req, res);
    } catch (error) { res.status(Number(error.status) || 500).json({ error: error.code ? error.message : 'Der Marketingauftrag konnte nicht abgeschlossen werden.', code: error.code || 'MARKETING_FAILED' }); }
  };
  const base = '/api/marketing/projects';
  app.get(base, route(async (_req, res) => res.json(await service.projects())));
  app.get(`${base}/:projectId`, route(async (req, res) => res.json(await service.snapshot(req.params.projectId))));
  app.post(`${base}/:projectId/profile`, route(async (req, res) => res.json(await service.saveProfile(req.params.projectId, req.body || {}))));
  app.post(`${base}/:projectId/logo`, express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '3mb' }), route(async (req, res) => res.json(await service.saveLogo(req.params.projectId, req.body, String(req.headers['content-type'] || '').split(';')[0]))));
  app.get(`${base}/:projectId/logo`, route(async (req, res) => {
    const logo = await service.logo(req.params.projectId);
    if (!logo) { res.status(404).json({ error: 'Noch kein Logo hinterlegt.' }); return; }
    res.set({ 'Content-Type': logo.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(Buffer.from(logo.data, 'base64'));
  }));
  app.post(`${base}/:projectId/research`, route(async (req, res) => res.status(202).json(await service.startJob(req.params.projectId, 'research', req.body || {}))));
  app.post(`${base}/:projectId/drafts`, route(async (req, res) => res.status(202).json(await service.startJob(req.params.projectId, 'content', req.body || {}))));
  app.post(`${base}/:projectId/videos/quote`, route(async (req, res) => res.status(201).json(await service.quoteVideo(req.params.projectId, req.body || {}))));
  app.post(`${base}/:projectId/videos`, route(async (req, res) => res.status(202).json(await service.submitVideo(req.params.projectId, req.body || {}))));
  app.get(`${base}/:projectId/videos/:id`, route(async (req, res) => res.json(await service.videoStatus(req.params.projectId, req.params.id))));
  return service;
}

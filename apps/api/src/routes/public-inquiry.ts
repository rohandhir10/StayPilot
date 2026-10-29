import type { FastifyInstance } from 'fastify';
import { env } from '../config.js';
import { fail, normalizeEmail, noStore, clientIpForRateLimiting } from '../http.js';
import { getDefaultWorkspaceId } from '../auth.js';
import { createLeadRecord } from '../domain.js';
import { hitRateLimit } from '../security.js';
import { publicLeadSchema } from '../validation.js';
import { verifyTurnstile } from '../turnstile.js';

export async function registerPublicInquiryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/public/form-config', async (_request, reply) => {
    noStore(reply);
    if (!env.turnstileSiteKey || !env.turnstileSecretKey) {
      return fail(reply, 503, 'Website inquiry protection is not configured.', 'captcha_setup_required');
    }
    return reply.send({ captcha_required: true, captcha_provider: 'cloudflare_turnstile', site_key: env.turnstileSiteKey });
  });

  app.post('/api/public/inquiry', async (request, reply) => {
    const raw = request.body;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(reply, 400, 'A JSON object is required.', 'invalid_request');
    if (JSON.stringify(raw).length > 12000) return fail(reply, 413, 'Inquiry request is too large.', 'request_too_large');
    const body = raw as Record<string, unknown>;
    if (typeof body.website === 'string' && body.website.trim()) return reply.code(202).send({ received: true });
    if (body.privacy_consent !== true && body.privacy_consent !== 'true' && body.privacy_consent !== 'on' && body.privacy_consent !== '1') {
      return fail(reply, 400, 'Consent is required to submit this inquiry.', 'consent_required');
    }
    const startedAt = Number(body.form_started_at);
    const elapsed = Date.now() - startedAt;
    if (!Number.isFinite(startedAt) || elapsed < 1800 || elapsed > 3_600_000) return fail(reply, 400, 'Please reload the inquiry form and try again.', 'invalid_form_timing');
    const email = normalizeEmail(body.client_email);
    if (!email) return fail(reply, 400, 'A valid contact email is required.', 'invalid_contact_email');
    if (!env.turnstileSecretKey) return fail(reply, 503, 'The hotel inquiry form is awaiting security setup.', 'captcha_setup_required');
    const token = typeof body.turnstile_token === 'string' ? body.turnstile_token : '';
    if (!token || token.length > 4096) return fail(reply, 400, 'Complete the security check and try again.', 'captcha_required');

    // Apply the IP limit before making an outbound CAPTCHA verification request.
    try {
      if (!(await hitRateLimit(`website-ip:${clientIpForRateLimiting(request)}`, 30, 3600))) {
        reply.header('Retry-After', '3600');
        return fail(reply, 429, 'Too many inquiries came from this connection. Please try later.', 'rate_limit_exceeded');
      }
    } catch {
      return fail(reply, 503, 'The inquiry form is temporarily unavailable.', 'rate_limit_unavailable');
    }

    let captchaValid = false;
    try {
      const expectedHostnames = env.webOrigins.map(origin => new URL(origin).hostname.toLowerCase());
      captchaValid = await verifyTurnstile(env.turnstileSecretKey, token, expectedHostnames);
    } catch {
      return fail(reply, 503, 'The security check is temporarily unavailable.', 'captcha_unavailable');
    }
    if (!captchaValid) return fail(reply, 400, 'The security check could not be verified for this website.', 'captcha_invalid');
    try {
      if (!(await hitRateLimit(`website-email:${email}`, env.publicRateLimitPerHour, 3600))) {
        reply.header('Retry-After', '3600');
        return fail(reply, 429, 'Too many inquiries were submitted for this contact. Please try later.', 'rate_limit_exceeded');
      }
      const parsed = publicLeadSchema.safeParse({ ...body, client_email: email, privacy_consent: true });
      if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message || 'Inquiry data is invalid.', 'invalid_inquiry');
      const lead = await createLeadRecord({
        workspaceId: await getDefaultWorkspaceId(),
        actor: null, lead: parsed.data,
        activityDescription: 'Website inquiry received',
        auditMetadata: { privacy_consent: true, consented_at: new Date().toISOString(), capture_method: 'public_website_form' }
      });
      noStore(reply);
      return reply.code(201).send({ received: true, reference: String(lead.id).slice(0, 8) });
    } catch {
      return fail(reply, 500, 'The inquiry could not be received. Please contact the hotel directly.', 'inquiry_submission_failed');
    }
  });
}

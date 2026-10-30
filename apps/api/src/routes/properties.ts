import type { FastifyInstance } from 'fastify';
import { pool, inTransaction } from '../db.js';
import { requireWorkspaceMember } from '../auth.js';
import { fail, noStore, isUuid } from '../http.js';
import { auditEvent } from '../domain.js';
import { hotelPropertyCreateSchema, hotelPropertyUpdateSchema } from '../validation.js';

type PropertyRow = {
  id: string;
  workspace_id: string;
  name: string;
  city: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

function databaseCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : null;
}

export async function registerPropertyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/properties', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply);
    if (!member) return;
    try {
      const { rows } = await pool.query(
        `SELECT p.id, p.name, p.city, p.is_active, p.created_at, p.updated_at,
                count(l.id)::int AS inquiry_count
         FROM hotel_properties p
         LEFT JOIN leads l
           ON l.workspace_id=p.workspace_id AND lower(l.property_name)=lower(p.name)
         WHERE p.workspace_id=$1
         GROUP BY p.id
         ORDER BY p.is_active DESC, lower(p.name) ASC`,
        [member.workspace_id]
      );
      noStore(reply);
      return reply.send({ properties: rows });
    } catch {
      return fail(reply, 500, 'Could not load hotel properties.', 'properties_list_failed');
    }
  });

  app.post('/api/properties', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner', 'admin']);
    if (!member) return;
    const parsed = hotelPropertyCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, parsed.error.issues[0]?.message || 'Property details are invalid.', 'invalid_property');
    }
    try {
      const property = await inTransaction(async client => {
        // Serialize changes to this workspace's property directory.
        await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [member.workspace_id]);
        const result = await client.query<PropertyRow>(
          `INSERT INTO hotel_properties (workspace_id, name, city, created_by_user_id)
           VALUES ($1,$2,$3,$4)
           RETURNING id, workspace_id, name, city, is_active, created_at, updated_at`,
          [member.workspace_id, parsed.data.name, parsed.data.city, member.user_id]
        );
        const created = result.rows[0];
        if (!created) throw new Error('property_create_failed');
        await auditEvent(client, {
          workspaceId: member.workspace_id, actor: member, action: 'property.created',
          entityType: 'hotel_property', entityId: created.id,
          metadata: { name: created.name, city: created.city }
        });
        return created;
      });
      noStore(reply);
      return reply.code(201).send({ property, message: 'Hotel property added to this workspace.' });
    } catch (error) {
      if (databaseCode(error) === '23505') {
        return fail(reply, 409, 'A property with this name already exists in this workspace.', 'property_name_conflict');
      }
      return fail(reply, 500, 'Could not create the hotel property.', 'property_create_failed');
    }
  });

  app.patch('/api/properties/:id', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner', 'admin']);
    if (!member) return;
    const id = (request.params as { id?: string }).id || '';
    if (!isUuid(id)) return fail(reply, 400, 'A valid property ID is required.', 'invalid_property_id');
    const parsed = hotelPropertyUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, parsed.error.issues[0]?.message || 'Property update is invalid.', 'invalid_property_update');
    }
    try {
      const outcome = await inTransaction(async client => {
        await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [member.workspace_id]);
        const currentResult = await client.query<PropertyRow>(
          `SELECT id, workspace_id, name, city, is_active, created_at, updated_at
           FROM hotel_properties WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
          [id, member.workspace_id]
        );
        const current = currentResult.rows[0];
        if (!current) return { kind: 'missing' as const };

        const nextName = parsed.data.name ?? current.name;
        const nextCity = parsed.data.city ?? current.city;
        const nextActive = parsed.data.is_active ?? current.is_active;
        if (current.is_active && !nextActive) {
          const count = await client.query<{ active_count: number }>(
            'SELECT count(*)::int AS active_count FROM hotel_properties WHERE workspace_id=$1 AND is_active=true',
            [member.workspace_id]
          );
          if (Number(count.rows[0]?.active_count || 0) <= 1) return { kind: 'last_active' as const };
        }

        const updatedResult = await client.query<PropertyRow>(
          `UPDATE hotel_properties
           SET name=$1, city=$2, is_active=$3, updated_at=now()
           WHERE id=$4 AND workspace_id=$5
           RETURNING id, workspace_id, name, city, is_active, created_at, updated_at`,
          [nextName, nextCity, nextActive, id, member.workspace_id]
        );
        const updated = updatedResult.rows[0];
        if (!updated) return { kind: 'missing' as const };

        if (nextName !== current.name) {
          // Preserve the historical inquiry association when a property is renamed.
          await client.query(
            `UPDATE leads SET property_name=$1, updated_at=now()
             WHERE workspace_id=$2 AND lower(property_name)=lower($3)`,
            [nextName, member.workspace_id, current.name]
          );
        }
        await auditEvent(client, {
          workspaceId: member.workspace_id, actor: member, action: 'property.updated',
          entityType: 'hotel_property', entityId: id,
          metadata: {
            previous_name: current.name, name: updated.name, city: updated.city,
            is_active: updated.is_active
          }
        });
        return { kind: 'updated' as const, property: updated };
      });

      if (outcome.kind === 'missing') return fail(reply, 404, 'Hotel property not found in this workspace.', 'property_not_found');
      if (outcome.kind === 'last_active') return fail(reply, 409, 'A workspace must keep at least one active hotel property.', 'last_active_property');
      noStore(reply);
      return reply.send({ property: outcome.property });
    } catch (error) {
      if (databaseCode(error) === '23505') {
        return fail(reply, 409, 'A property with this name already exists in this workspace.', 'property_name_conflict');
      }
      return fail(reply, 500, 'Could not update the hotel property.', 'property_update_failed');
    }
  });
}

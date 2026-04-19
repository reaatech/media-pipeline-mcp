/**
 * Authentication & Authorization Middleware
 *
 * Supports:
 * - API key authentication
 * - JWT/OAuth2 authentication
 * - Role-based access control (RBAC)
 */

import jwt from 'jsonwebtoken';
import { z } from 'zod';

// Role definitions
export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  email: string;
  role: Role;
  permissions: string[];
  tenantId?: string;
}

export interface AuthConfig {
  jwtSecret?: string;
  apiKeyHeader?: string;
  apiKeys?: Map<string, { userId: string; permissions: string[]; tenantId?: string }>;
  requireAuth: boolean;
}

export interface AuthContext {
  user?: User;
  authenticated: boolean;
  permissions: string[];
  tenantId?: string;
}

// Permission definitions
export const Permissions = {
  // Pipeline operations
  PIPELINE_RUN: 'pipeline:run',
  PIPELINE_DEFINE: 'pipeline:define',
  PIPELINE_RESUME: 'pipeline:resume',

  // Artifact operations
  ARTIFACT_READ: 'artifact:read',
  ARTIFACT_WRITE: 'artifact:write',
  ARTIFACT_DELETE: 'artifact:delete',

  // Provider operations
  PROVIDER_MANAGE: 'provider:manage',

  // Cost operations
  COST_READ: 'cost:read',

  // Admin operations
  ADMIN_USERS: 'admin:users',
  ADMIN_CONFIG: 'admin:config',
} as const;

// Role to permissions mapping
const RolePermissions: Record<Role, string[]> = {
  admin: Object.values(Permissions),
  operator: [
    Permissions.PIPELINE_RUN,
    Permissions.PIPELINE_DEFINE,
    Permissions.PIPELINE_RESUME,
    Permissions.ARTIFACT_READ,
    Permissions.ARTIFACT_WRITE,
    Permissions.COST_READ,
  ],
  viewer: [Permissions.PIPELINE_RUN, Permissions.ARTIFACT_READ, Permissions.COST_READ],
};

// JWT payload schema
const JwtPayloadSchema = z.object({
  sub: z.string(),
  email: z.string().email(),
  role: z.enum(['admin', 'operator', 'viewer']).optional(),
  permissions: z.array(z.string()).optional(),
  tenant_id: z.string().optional(),
  exp: z.number(),
});

export class AuthMiddleware {
  private config: AuthConfig;

  constructor(config: AuthConfig) {
    if (config.jwtSecret && config.jwtSecret.length < 32) {
      throw new Error('jwtSecret must be at least 32 characters for adequate security');
    }
    if (!config.jwtSecret && (!config.apiKeys || config.apiKeys.size === 0) && config.requireAuth) {
      throw new Error('Authentication requires either jwtSecret or apiKeys');
    }
    this.config = config;
  }

  /**
   * Authenticate request using API key or JWT
   */
  async authenticate(headers: Record<string, string | undefined>): Promise<AuthContext> {
    // Try API key first
    const apiKeyHeader = this.config.apiKeyHeader || 'X-API-Key';
    const apiKey = headers[apiKeyHeader.toLowerCase()];

    if (apiKey && this.config.apiKeys) {
      // Use constant-time comparison to prevent timing attacks
      for (const [storedKey, keyData] of this.config.apiKeys.entries()) {
        if (this.constantTimeEquals(apiKey, storedKey)) {
          return {
            authenticated: true,
            user: {
              id: keyData.userId,
              email: `${keyData.userId}@local`,
              role: 'operator',
              permissions: keyData.permissions,
            },
            permissions: keyData.permissions,
            tenantId: keyData.tenantId,
          };
        }
      }
    }

    // Try JWT
    const authHeader = headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      return this.authenticateJwt(token);
    }

    if (this.config.requireAuth) {
      return { authenticated: false, permissions: [], user: undefined };
    }

    return { authenticated: true, permissions: [], user: undefined };
  }

  /**
   * Authenticate JWT token
   */
  private authenticateJwt(token: string): AuthContext {
    if (!this.config.jwtSecret) {
      return { authenticated: false, permissions: [], user: undefined };
    }

    try {
      const payload = jwt.verify(token, this.config.jwtSecret, { algorithms: ['HS256'] });
      const validated = JwtPayloadSchema.parse(payload);

      const role = validated.role || 'viewer';
      const rolePermissions = RolePermissions[role];
      const permissions = validated.permissions
        ? validated.permissions.filter((p) => rolePermissions.includes(p))
        : rolePermissions;

      return {
        authenticated: true,
        user: {
          id: validated.sub,
          email: validated.email,
          role,
          permissions,
        },
        permissions,
        tenantId: validated.tenant_id,
      };
    } catch {
      return { authenticated: false, permissions: [], user: undefined };
    }
  }

  /**
   * Check if context has required permission
   */
  hasPermission(context: AuthContext, permission: string): boolean {
    return context.permissions.includes(permission);
  }

  /**
   * Check if context can perform operation
   */
  canPerformOperation(context: AuthContext, operation: string): boolean {
    // Map operations to permissions
    const operationPermissions: Record<string, string> = {
      'image.generate': Permissions.PIPELINE_RUN,
      'image.upscale': Permissions.PIPELINE_RUN,
      'image.remove_background': Permissions.PIPELINE_RUN,
      'image.inpaint': Permissions.PIPELINE_RUN,
      'image.describe': Permissions.PIPELINE_RUN,
      'image.resize': Permissions.PIPELINE_RUN,
      'image.crop': Permissions.PIPELINE_RUN,
      'image.composite': Permissions.PIPELINE_RUN,
      'audio.tts': Permissions.PIPELINE_RUN,
      'audio.stt': Permissions.PIPELINE_RUN,
      'audio.diarize': Permissions.PIPELINE_RUN,
      'audio.isolate': Permissions.PIPELINE_RUN,
      'video.generate': Permissions.PIPELINE_RUN,
      'video.image_to_video': Permissions.PIPELINE_RUN,
      'video.extract_frames': Permissions.PIPELINE_RUN,
      'video.extract_audio': Permissions.PIPELINE_RUN,
      'document.ocr': Permissions.PIPELINE_RUN,
      'document.extract_tables': Permissions.PIPELINE_RUN,
      'document.extract_fields': Permissions.PIPELINE_RUN,
      'document.summarize': Permissions.PIPELINE_RUN,
      'media.pipeline.run': Permissions.PIPELINE_RUN,
      'media.pipeline.define': Permissions.PIPELINE_DEFINE,
      'media.pipeline.resume': Permissions.PIPELINE_RESUME,
      'media.artifact.get': Permissions.ARTIFACT_READ,
      'media.artifact.list': Permissions.ARTIFACT_READ,
      'media.artifact.delete': Permissions.ARTIFACT_DELETE,
      'media.providers.list': Permissions.PROVIDER_MANAGE,
      'media.costs.summary': Permissions.COST_READ,
      'quality_gate.evaluate': Permissions.PIPELINE_RUN,
      'image.generate.batch': Permissions.PIPELINE_RUN,
      'audio.music': Permissions.PIPELINE_RUN,
      'audio.sound_effect': Permissions.PIPELINE_RUN,
      'image.image_to_image': Permissions.PIPELINE_RUN,
      'media.pipeline.status': Permissions.ARTIFACT_READ,
      'media.pipeline.templates': Permissions.ARTIFACT_READ,
    };

    const requiredPermission = operationPermissions[operation];
    if (!requiredPermission) {
      return false;
    }

    return this.hasPermission(context, requiredPermission);
  }

  /**
   * Constant-time string comparison to prevent timing attacks
   */
  private constantTimeEquals(a: string, b: string): boolean {
    const maxLen = Math.max(a.length, b.length);
    let result = a.length ^ b.length;
    for (let i = 0; i < maxLen; i++) {
      result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    return result === 0;
  }

  /**
   * Generate JWT token for user
   */
  generateToken(user: Omit<User, 'id'> & { id: string }, expiresIn: string = '24h'): string {
    if (!this.config.jwtSecret) {
      throw new Error('jwtSecret is required to generate JWT tokens');
    }

    return jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        permissions: user.permissions,
        tenant_id: user.tenantId,
      },
      this.config.jwtSecret as jwt.Secret,
      { expiresIn } as jwt.SignOptions
    );
  }
}

// Default role-based access control
export function createRBACMiddleware(config: AuthConfig): AuthMiddleware {
  return new AuthMiddleware(config);
}

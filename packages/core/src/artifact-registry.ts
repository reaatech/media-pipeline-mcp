import { v4 as uuidv4 } from 'uuid';
import type { Artifact } from './types/index.js';

export interface ArtifactRegistryInterface {
  register(artifact: Omit<Artifact, 'id'>): Artifact;
  registerWithId(id: string, artifact: Omit<Artifact, 'id'>): Artifact;
  get(id: string): Artifact | undefined;
  delete(id: string): boolean;
  list(): Artifact[];
  findBySourceStep(stepId: string): Artifact | undefined;
  clear(): void;
}

export class ArtifactRegistry implements ArtifactRegistryInterface {
  private artifacts: Map<string, Artifact> = new Map();

  register(artifact: Omit<Artifact, 'id'>): Artifact {
    return this.registerWithId(uuidv4(), artifact);
  }

  registerWithId(id: string, artifact: Omit<Artifact, 'id'>): Artifact {
    const fullArtifact: Artifact = {
      ...artifact,
      id,
      createdAt: new Date().toISOString(),
    };
    this.artifacts.set(id, fullArtifact);
    return fullArtifact;
  }

  get(id: string): Artifact | undefined {
    return this.artifacts.get(id);
  }

  delete(id: string): boolean {
    return this.artifacts.delete(id);
  }

  list(): Artifact[] {
    return Array.from(this.artifacts.values());
  }

  findBySourceStep(stepId: string): Artifact | undefined {
    let latest: Artifact | undefined;
    for (const artifact of this.artifacts.values()) {
      if (artifact.sourceStep === stepId) {
        if (
          !latest ||
          (artifact.createdAt && latest.createdAt && artifact.createdAt > latest.createdAt)
        ) {
          latest = artifact;
        }
      }
    }
    return latest;
  }

  deleteBySourceStep(stepId: string): number {
    let deleted = 0;
    for (const [id, artifact] of this.artifacts.entries()) {
      if (artifact.sourceStep === stepId) {
        this.artifacts.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  clear(): void {
    this.artifacts.clear();
  }

  size(): number {
    return this.artifacts.size;
  }
}

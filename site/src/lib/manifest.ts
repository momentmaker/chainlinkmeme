export interface MemeEntry {
  slug: string;
  filename: string;
  ext: 'jpg' | 'jpeg' | 'png' | 'gif' | 'webp';
  title: string;
  tags: string[];
  description: string;
  credit: string;
  source_url: string;
  submitted_by: string;
  date_added: string;
  nsfw: boolean;
  animated: boolean;
  width: number;
  height: number;
}

export interface Manifest {
  generated_at: string;
  repo_ref: string;
  memes: MemeEntry[];
  tags: string[];
  synonyms: Record<string, string[]>;
  related: Record<string, string[]>;
}

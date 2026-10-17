CREATE TABLE IF NOT EXISTS recognition_posts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 description text NOT NULL,
 media_key text,
 media_type text,
 media_name text,
 media_bytes bigint,
 author_admin text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recognition_posts_created_idx ON recognition_posts(created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS recognition_comments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 post_id uuid NOT NULL REFERENCES recognition_posts(id) ON DELETE CASCADE,
 marketer_id text NOT NULL,
 parent_comment_id uuid REFERENCES recognition_comments(id) ON DELETE CASCADE,
 body text NOT NULL,
 deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recognition_comments_post_idx ON recognition_comments(post_id,created_at,id);
CREATE INDEX IF NOT EXISTS recognition_comments_marketer_idx ON recognition_comments(marketer_id,created_at DESC);
CREATE TABLE IF NOT EXISTS recognition_post_reactions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 post_id uuid NOT NULL REFERENCES recognition_posts(id) ON DELETE CASCADE,
 marketer_id text NOT NULL,
 reaction text NOT NULL CHECK(reaction IN ('like','love')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(post_id,marketer_id)
);
CREATE TABLE IF NOT EXISTS recognition_comment_reactions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 comment_id uuid NOT NULL REFERENCES recognition_comments(id) ON DELETE CASCADE,
 marketer_id text NOT NULL,
 reaction text NOT NULL CHECK(reaction IN ('like','love')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(comment_id,marketer_id)
);
CREATE TABLE IF NOT EXISTS recognition_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 recipient_marketer_id text NOT NULL,
 actor_marketer_id text,
 post_id uuid REFERENCES recognition_posts(id) ON DELETE CASCADE,
 comment_id uuid REFERENCES recognition_comments(id) ON DELETE CASCADE,
 event_type text NOT NULL,
 message text NOT NULL,
 read_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recognition_notifications_unread_idx ON recognition_notifications(recipient_marketer_id,read_at,created_at DESC);
CREATE TABLE IF NOT EXISTS recognition_marketer_controls (
 marketer_id text PRIMARY KEY,
 can_post boolean NOT NULL DEFAULT false,
 comments_blocked boolean NOT NULL DEFAULT false,
 posts_hidden boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- .headers on

create table _yamanote_db_state (schemaVersion integer not null);
insert into
  _yamanote_db_state (schemaVersion)
values
  (5);
create table user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  displayName text not null,
  githubId integer unique not null
);
create table token (
  token text primary key not null,
  description text not null,
  userId integer not null
);
create table bookmark (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId integer not null,
  url text not null,
  title text not null,
  createdTime float not null,
  modifiedTime float not null,
  render text not null,
  unique (url, title, userId)
);
create table comment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bookmarkId integer not null,
  content text not null,
  createdTime float not null,
  modifiedTime float not null,
  -- just `content` column, in a <div class="comment"></div>
  contentOnlyRender text not null,
  -- wrap the bookmark's partialRender around the contentOnlyRender
  fullRender text not null
);
create table backup (
  id INTEGER PRIMARY KEY,
  bookmarkId integer not null,
  content text not null,
  original text not null,
  createdTime float not null
);
-- a path that points to a hash
create table media (
  id INTEGER PRIMARY KEY,
  -- url or filename
  path text not null,
  bookmarkId integer not null,
  sha256 text not null, 
  createdTime float not null,
  unique (sha256, path, bookmarkId)
);
create table blob (
  id INTEGER PRIMARY KEY,
  content blob not null,
  mime text not null,
  createdTime float not null,
  numBytes integer not null,
  sha256 text unique not null
);

create view comment_graph (id, idx, olderCommentSameBookmark, newerCommentSameBookmark, olderId, newerId) as
select
  id,
  ROW_NUMBER() OVER (PARTITION BY bookmarkId ORDER BY createdTime) idx,
  bookmarkId = LAG(bookmarkId) OVER (ORDER BY createdTime) olderCommentSameBookmark,
  bookmarkId = LEAD(bookmarkId) OVER (ORDER BY createdTime) newerCommentSameBookmark,
  LAG(id) OVER (PARTITION BY bookmarkId ORDER BY createdTime) olderId,
  LEAD(id) OVER (PARTITION BY bookmarkId ORDER BY createdTime) newerId
FROM comment;

-- create view comment_count (bookmarkId, numComments) as
-- select bookmarkId, count(*) from comment group by bookmarkId;


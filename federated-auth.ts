import sqlite3 from 'better-sqlite3';
import KnexSession from 'connect-session-knex';
import {Express, RequestHandler} from 'express';
import Knex, {Knex as KnexType} from 'knex';
import passport from 'passport';
import GitHubStrategy from 'passport-github';

import * as Table from './DbTablesV3';
import {Env, FullRow, Selected} from './pathsInterfaces';

type Db = ReturnType<typeof sqlite3>;

function findOrCreateGithub(db: Db, profile: GitHubStrategy.Profile, allowlist: '*'|Set<string>): undefined|
    FullRow<Table.userRow> {
  if (typeof allowlist === 'object') {
    if (!allowlist.has(profile.id)) { return undefined; }
  }

  const githubId = typeof profile.id === 'number' ? profile.id : parseInt(profile.id);
  const row: Selected<Table.userRow> =
      db.prepare<{githubId: number}>(`select * from user where githubId=$githubId`).get({githubId});
  if (row) { return row; }

  const user: Table.userRow = {displayName: profile.username || profile.displayName || '', githubId};
  const res =
      db.prepare<Table.userRow>(`insert into user (displayName, githubId) values ($displayName, $githubId)`).run(user);
  if (res.changes > 0) { return {...user, id: res.lastInsertRowid}; }

  return undefined;
}

function getUser(db: Db, serialized: number|string): Selected<Table.userRow> {
  return db.prepare<{id: number | string}>(`select * from user where id=$id`).get({id: serialized});
}

export function passportSetup(db: Db, app: Express, sessionFilename: string): {knex: KnexType} {
  const decoded = Env.decode(require('dotenv').config()?.parsed);
  if (decoded._tag === 'Left') { throw new Error('.env failed to decode'); }
  const env = decoded.right;

  const githubAllowlist =
      (env.GITHUB_ID_ALLOWLIST === '*') ? '*' as const: new Set(env.GITHUB_ID_ALLOWLIST.split(',').map(s => s.trim()));

  passport.use(new GitHubStrategy(
      {
        clientID: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        callbackURL: `/auth/github/callback`,
      },
      // This function converts the GitHub profile into our app's object representing the user
      (accessToken, refreshToken, profile, cb) => cb(null, findOrCreateGithub(db, profile, githubAllowlist))));

  // Serialize an IUser into something we'll store in the user's session (very tiny)
  passport.serializeUser(function(user: any|FullRow<Table.userRow>, cb) { cb(null, user.id); });
  // Take the data we stored in the session (`gotandaId`) and resurrect the full IUser object
  passport.deserializeUser(function(obj: number|string, cb) { cb(null, getUser(db, obj)); });

  app.use(require('cookie-parser')());

  const knex = Knex({client: "sqlite3", useNullAsDefault: true, connection: {filename: sessionFilename}});
  const store = new (KnexSession(require('express-session')))({knex});

  app.use(require('express-session')({
    cookie: process.env.NODE_ENV === 'development' ? {secure: false, sameSite: 'lax'}
                                                   : {secure: true, sameSite: 'none'},
    secret: env.SESSION_SECRET,
    resave: true,
    rolling: true,
    saveUninitialized: true,
    store,
  }));
  // FIRST init express' session (above), THEN passport's (below)
  app.use(passport.initialize());
  app.use(passport.session());

  // All done with passport shenanigans. Set up some routes.
  app.get('/auth/github', ensureUnauthenticated, passport.authenticate('github'));
  app.get('/auth/github/callback', ensureUnauthenticated, passport.authenticate('github', {failureRedirect: '/'}),
          (req, res) => res.redirect('/'));
  app.get('/logout', (req, res) => {
    req.logout();
    res.redirect('/');
  });
  app.get('/loginstatus', ensureAuthenticated, (req, res) => {
    // console.log(req.user);
    res.send(`You're logged in! <a href="/">Go back</a>`);
  });

  return {knex};
}

export const ensureAuthenticated: RequestHandler = (req, res, next) => {
  // check session (i.e., GitHub, etc.)
  if (req.isAuthenticated && req.isAuthenticated()) { return next(); }
  return res.redirect('/auth/github');
};
// Via @jaredhanson: https://gist.github.com/joshbirk/1732068#gistcomment-80892
export const ensureUnauthenticated: RequestHandler = (req, res, next) => {
  if (req.isAuthenticated()) { return res.redirect('/'); }
  next();
};

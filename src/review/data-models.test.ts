import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractDataModels, parseEfCore, parsePrisma, parseSqlTables, readDataModels } from './data-models.js';
import { collectChangeSet, defaultRun } from './git.js';

/**
 * Data models as declared, with the line of every table, column and key:
 * the raw facts the data-store view is derived from.
 */

const brief = (fields: { key: string; primary_key?: boolean; nullable?: boolean; references?: { collection: string; field: string }; line: number }[]) =>
  fields.map((f) => `${f.key}${f.primary_key ? '*' : ''}${f.nullable ? '?' : ''}${f.references ? `->${f.references.collection}.${f.references.field}` : ''}@${f.line}`);

describe('Prisma', () => {
  const schema = [
    'datasource db {', //                                                1
    '  provider = "postgresql"', //                                      2
    '  url      = env("DATABASE_URL")', //                               3
    '}', //                                                              4
    '', //                                                               5
    'model User {', //                                                   6
    '  id     Int     @id @default(autoincrement())', //                 7
    '  email  String  @unique', //                                       8
    '  posts  Post[]', //                                                9
    '}', //                                                             10
    '', //                                                              11
    'model Post {', //                                                  12
    '  id       Int     @id', //                                        13
    '  title    String? @map("post_title")', //                         14
    '  authorId Int', //                                                15
    '  author   User    @relation(fields: [authorId], references: [id])', // 16
    '  @@map("posts")', //                                              17
    '}', //                                                             18
  ].join('\n');

  it('reads models, keys, relations and table names, with their lines', () => {
    const store = parsePrisma({ path: 'db/schema.prisma', text: schema })!;
    expect(store).toMatchObject({ key: 'prisma:db/schema.prisma', label: 'Prisma (postgresql)', storage: 'relational' });
    expect(store.collections.map((c) => [c.key, c.label, c.start, c.end])).toEqual([
      ['User', 'User', 6, 10],
      ['Post', 'posts', 12, 18],
    ]);
    expect(brief(store.collections[0].fields)).toEqual(['id*@7', 'email@8']);
    expect(brief(store.collections[1].fields)).toEqual(['id*@13', 'title?@14', 'authorId->User.id@15']);
    expect(store.collections[1].fields[1].label).toBe('post_title');
  });

  it('never reads the connection string', () => {
    expect(JSON.stringify(parsePrisma({ path: 's.prisma', text: schema }))).not.toContain('DATABASE_URL');
  });
});

describe('SQL DDL', () => {
  it('reads tables, column and table-level keys, with their lines', () => {
    const sql = [
      'CREATE TABLE IF NOT EXISTS "public"."customers" (', //   1
      '  id SERIAL PRIMARY KEY,', //                            2
      '  email TEXT NOT NULL', //                               3
      ');', //                                                  4
      'create table orders (', //                               5
      '  id int not null,', //                                  6
      '  customer_id int references customers(id),', //        7
      '  note text,', //                                        8
      '  primary key (id),', //                                 9
      '  constraint fk foreign key (customer_id) references customers (id)', // 10
      ');', //                                                 11
    ].join('\n');
    const tables = parseSqlTables({ path: 'db/init.sql', text: sql });
    expect(tables.map((t) => [t.key, t.start, t.end])).toEqual([
      ['customers', 1, 4],
      ['orders', 5, 11],
    ]);
    expect(brief(tables[0].fields)).toEqual(['id*@2', 'email@3']);
    expect(brief(tables[1].fields)).toEqual(['id*@6', 'customer_id?->customers.id@7', 'note?@8']);
  });
});

describe('EF Core', () => {
  const files = [
    {
      path: 'src/Infrastructure/AppDbContext.cs',
      text: [
        'using Shop.Domain.Entities;', //                                1
        'namespace Shop.Infrastructure;', //                             2
        'public class AppDbContext : DbContext', //                      3
        '{', //                                                          4
        '    public DbSet<Product> Products => Set<Product>();', //     5
        '    public DbSet<Category> Categories { get; set; }', //       6
        '}', //                                                          7
      ].join('\n'),
    },
    {
      path: 'src/Domain/Entities/Product.cs',
      text: [
        'namespace Shop.Domain.Entities;', //                            1
        'public class Product : BaseEntity', //                          2
        '{', //                                                          3
        '    public string Name { get; set; } = "";', //                4
        '    public Guid? CategoryId { get; set; }', //                  5
        '    public Category? CategoryNavigation { get; set; }', //     6
        '    public ICollection<Category> Related { get; set; } = new List<Category>();', // 7
        '}', //                                                          8
        'public abstract class BaseEntity', //                           9
        '{', //                                                         10
        '    [Key]', //                                                 11
        '    public Guid Key { get; set; }', //                         12
        '}', //                                                         13
      ].join('\n'),
    },
    { path: 'src/Domain/Entities/Category.cs', text: 'namespace Shop.Domain.Entities;\npublic class Category\n{\n    public Guid Id { get; set; }\n}\n' },
    // A DTO with the entity's name in another namespace must not be taken for it.
    { path: 'src/Api/Dtos.cs', text: 'namespace Shop.Api;\npublic class Product\n{\n    public string Wrong { get; set; }\n}\n' },
  ];

  it('reads every DbSet, the entity it names, its keys and its navigations', () => {
    const [store] = parseEfCore(files);
    expect(store).toMatchObject({ key: 'efcore:AppDbContext', label: 'AppDbContext', path: 'src/Infrastructure/AppDbContext.cs', line: 3 });
    expect(store.collections.map((c) => [c.key, c.label, c.path, c.start])).toEqual([
      ['Product', 'Products', 'src/Domain/Entities/Product.cs', 2],
      ['Category', 'Categories', 'src/Domain/Entities/Category.cs', 2],
    ]);
    // Own fields, then the base entity's [Key]; navigations and collections are not columns.
    expect(brief(store.collections[0].fields)).toEqual(['Name@4', 'CategoryId?->Category.Id@5', 'Key*@12']);
    expect(brief(store.collections[1].fields)).toEqual(['Id*@4']);
  });

  it('finds nothing where no context declares a DbSet', () => {
    expect(parseEfCore([files[1], files[2]])).toEqual([]);
  });
});

describe('readDataModels', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  };

  it('reads the reviewed side: the working tree in place, the head commit otherwise', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vg-data-models-')));
    roots.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@e.st');
    git(root, 'config', 'user.name', 'T');
    fs.mkdirSync(path.join(root, 'db'));
    fs.writeFileSync(path.join(root, 'db/schema.sql'), 'CREATE TABLE a (id int primary key);\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    fs.writeFileSync(path.join(root, 'db/schema.sql'), 'CREATE TABLE a (id int primary key);\nCREATE TABLE b (id int primary key);\n');
    const change = collectChangeSet(root, undefined, defaultRun);
    const tree = readDataModels(change, {});
    expect(tree[0].collections.map((c) => c.key)).toEqual(['a', 'b']);
    const committed = readDataModels(change, { base: 'HEAD' });
    expect(committed[0].collections.map((c) => c.key)).toEqual(['a']);
  });
});

describe('extractDataModels', () => {
  it('merges SQL across files (the latest declaration wins) and sorts stores', () => {
    const stores = extractDataModels([
      { path: 'migrations/002.sql', text: 'CREATE TABLE users (id int primary key, email text not null);' },
      { path: 'migrations/001.sql', text: 'CREATE TABLE users (id int primary key);' },
      { path: 'x.prisma', text: 'model A {\n  id Int @id\n}\n' },
    ]);
    expect(stores.map((s) => s.key)).toEqual(['prisma:x.prisma', 'sql']);
    expect(brief(stores[1].collections[0].fields)).toEqual(['id*@1', 'email@1']);
    expect(stores[1].collections[0].path).toBe('migrations/002.sql');
  });
});

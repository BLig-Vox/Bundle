import { Migration } from "@mikro-orm/migrations";

export class Migration20261106000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql('create table "users" ("id" serial primary key, "name" varchar(120) not null, "email" varchar(254) not null, "created_at" timestamptz not null, "updated_at" timestamptz not null);');
    this.addSql('alter table "users" add constraint "users_email_unique" unique ("email");');
    this.addSql('create table "posts" ("id" serial primary key, "title" varchar(200) not null, "slug" varchar(200) not null, "body" text not null, "author_id" int not null, "created_at" timestamptz not null, "updated_at" timestamptz not null);');
    this.addSql('alter table "posts" add constraint "posts_slug_unique" unique ("slug");');
    this.addSql('alter table "posts" add constraint "posts_author_id_foreign" foreign key ("author_id") references "users" ("id") on delete cascade;');
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "posts";');
    this.addSql('drop table if exists "users";');
  }
}

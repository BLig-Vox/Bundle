import { Migration } from "@mikro-orm/migrations";

export class Migration20261106000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql('create table `users` (`id` integer not null primary key autoincrement, `name` text not null, `email` text not null, `created_at` datetime not null, `updated_at` datetime not null);');
    this.addSql('create unique index `users_email_unique` on `users` (`email`);');
    this.addSql('create table `posts` (`id` integer not null primary key autoincrement, `title` text not null, `slug` text not null, `body` text not null, `author_id` integer not null, `created_at` datetime not null, `updated_at` datetime not null, constraint `posts_author_id_foreign` foreign key (`author_id`) references `users` (`id`) on delete cascade);');
    this.addSql('create unique index `posts_slug_unique` on `posts` (`slug`);');
    this.addSql('create index `posts_author_id_index` on `posts` (`author_id`);');
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists `posts`;');
    this.addSql('drop table if exists `users`;');
  }
}

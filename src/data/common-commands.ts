/**
 * Common commands grouped by prefix.
 * Used to suggest commands even when user has no history.
 */
const COMMANDS: Record<string, string[]> = {
  git: [
    "git status",
    "git add .",
    "git commit -m ''",
    "git push",
    "git pull",
    "git branch",
    "git checkout",
    "git diff",
    "git log --oneline",
    "git stash",
    "git merge",
    "git rebase",
    "git fetch",
    "git clone",
    "git reset --soft HEAD~1",
    "git cherry-pick",
    "git remote -v",
    "git tag",
  ],
  npm: [
    "npm install",
    "npm run dev",
    "npm run build",
    "npm run test",
    "npm run start",
    "npm init -y",
    "npm update",
    "npm outdated",
    "npm list --depth=0",
    "npm publish",
    "npm link",
    "npm uninstall",
    "npm cache clean --force",
    "npm audit fix",
  ],
  npx: [
    "npx create-next-app@latest",
    "npx create-react-app",
    "npx prisma generate",
    "npx prisma migrate dev",
    "npx tsc --noEmit",
    "npx eslint .",
    "npx prettier --write .",
  ],
  bun: [
    "bun install",
    "bun run dev",
    "bun run build",
    "bun test",
    "bun add",
    "bun remove",
    "bun init",
    "bun upgrade",
    "bun run start",
    "bun link",
    "bun build --compile",
  ],
  docker: [
    "docker compose up -d",
    "docker compose down",
    "docker compose logs -f",
    "docker compose build",
    "docker compose ps",
    "docker ps",
    "docker images",
    "docker build -t",
    "docker run -it",
    "docker exec -it",
    "docker stop",
    "docker rm",
    "docker rmi",
    "docker system prune -f",
    "docker volume ls",
    "docker network ls",
  ],
  yarn: [
    "yarn install",
    "yarn dev",
    "yarn build",
    "yarn test",
    "yarn add",
    "yarn remove",
    "yarn upgrade",
    "yarn start",
  ],
  pnpm: [
    "pnpm install",
    "pnpm run dev",
    "pnpm run build",
    "pnpm add",
    "pnpm remove",
    "pnpm dlx",
  ],
  brew: [
    "brew install",
    "brew update",
    "brew upgrade",
    "brew list",
    "brew search",
    "brew uninstall",
    "brew cleanup",
    "brew info",
    "brew doctor",
    "brew services list",
    "brew services start",
    "brew services stop",
  ],
  curl: [
    "curl -X GET",
    "curl -X POST",
    "curl -sL",
    "curl -o",
    "curl -I",
    "curl -H 'Content-Type: application/json'",
    "curl -d '{}'",
  ],
  ssh: [
    "ssh-keygen -t ed25519",
    "ssh-copy-id",
    "ssh -i",
    "ssh -L",
    "ssh -p",
  ],
  python: [
    "python -m venv venv",
    "python -m pip install",
    "python -m pytest",
    "python manage.py runserver",
    "python manage.py migrate",
  ],
  pip: [
    "pip install",
    "pip install -r requirements.txt",
    "pip freeze > requirements.txt",
    "pip list",
    "pip uninstall",
  ],
  go: [
    "go run .",
    "go build",
    "go test ./...",
    "go mod tidy",
    "go mod init",
    "go get",
    "go fmt ./...",
    "go vet ./...",
  ],
  cargo: [
    "cargo build",
    "cargo run",
    "cargo test",
    "cargo add",
    "cargo fmt",
    "cargo clippy",
    "cargo init",
    "cargo publish",
  ],
  make: [
    "make build",
    "make test",
    "make clean",
    "make install",
    "make all",
  ],
  kubectl: [
    "kubectl get pods",
    "kubectl get services",
    "kubectl get deployments",
    "kubectl logs",
    "kubectl describe pod",
    "kubectl apply -f",
    "kubectl delete",
    "kubectl exec -it",
    "kubectl port-forward",
    "kubectl config use-context",
  ],
  systemctl: [
    "systemctl status",
    "systemctl start",
    "systemctl stop",
    "systemctl restart",
    "systemctl enable",
    "systemctl disable",
    "systemctl list-units",
  ],
  pm2: [
    "pm2 list",
    "pm2 start",
    "pm2 stop",
    "pm2 restart",
    "pm2 logs",
    "pm2 delete",
    "pm2 monit",
    "pm2 save",
  ],
  tar: [
    "tar -czf archive.tar.gz",
    "tar -xzf",
    "tar -xvf",
    "tar -tf",
  ],
  find: [
    "find . -name",
    "find . -type f",
    "find . -type d",
    "find . -mtime",
    "find . -size",
  ],
  grep: [
    "grep -r",
    "grep -rn",
    "grep -ri",
    "grep -l",
    "grep -v",
  ],
  chmod: [
    "chmod +x",
    "chmod 755",
    "chmod 644",
    "chmod -R",
  ],
  vercel: [
    "vercel deploy",
    "vercel dev",
    "vercel env pull",
    "vercel logs",
    "vercel ls",
  ],
  supabase: [
    "supabase start",
    "supabase stop",
    "supabase db reset",
    "supabase migration new",
    "supabase gen types typescript",
    "supabase db push",
  ],
};

/** Get common command suggestions for a query */
export function getCommonSuggestions(query: string, limit: number = 5): string[] {
  const q = query.toLowerCase();
  const results: string[] = [];

  // Try prefix match on command groups
  for (const [prefix, commands] of Object.entries(COMMANDS)) {
    if (prefix.startsWith(q) || q.startsWith(prefix)) {
      for (const cmd of commands) {
        if (cmd.toLowerCase().startsWith(q) || cmd.toLowerCase().includes(q)) {
          results.push(cmd);
          if (results.length >= limit) return results;
        }
      }
    }
  }

  // Fallback: search all commands
  if (results.length < limit) {
    const seen = new Set(results);
    for (const commands of Object.values(COMMANDS)) {
      for (const cmd of commands) {
        if (!seen.has(cmd) && cmd.toLowerCase().includes(q)) {
          results.push(cmd);
          if (results.length >= limit) return results;
        }
      }
    }
  }

  return results;
}

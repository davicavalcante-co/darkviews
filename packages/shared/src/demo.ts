// Contas de TESTE para desenvolvimento local. Nunca use em produção.
// shortcut: senhas fixas e públicas no repo; apague as contas antes de usar o sistema de verdade.
export const DEMO_USERS = [
  { email: 'admin.teste@local.test', name: 'Admin Teste', role: 'admin', password: 'admin-teste-123' },
  { email: 'usuario.teste@local.test', name: 'Usuário Teste', role: 'user', password: 'usuario-teste-123' },
] as const

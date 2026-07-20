export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { bootServer } = await import('./src/server/boot');
    await bootServer();
  }
}

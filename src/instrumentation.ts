export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { bootServer } = await import('./server/boot');
    await bootServer();
  }
}

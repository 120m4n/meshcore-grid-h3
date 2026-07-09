import { register } from './api.ts';
import { showToast } from './toast.ts';

document.getElementById('register-form')!.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await register(
      (document.getElementById('email') as HTMLInputElement).value,
      (document.getElementById('password') as HTMLInputElement).value,
      (document.getElementById('display_name') as HTMLInputElement).value
    );
    localStorage.setItem('token', res.token);
    localStorage.setItem('role', 'user');
    window.location.href = '/';
  } catch (err: any) {
    showToast(err.message || 'No se pudo crear la cuenta.', 'error');
  }
});

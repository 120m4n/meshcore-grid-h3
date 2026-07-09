import { login } from './api.ts';
import { showToast } from './toast.ts';

document.getElementById('login-form')!.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await login(
      (document.getElementById('email') as HTMLInputElement).value,
      (document.getElementById('password') as HTMLInputElement).value
    );
    localStorage.setItem('token', res.token);
    // decodificar el rol del JWT (payload base64) para mostrar/ocultar nav admin
    const payload = JSON.parse(atob(res.token.split('.')[1]));
    localStorage.setItem('role', payload.role);
    window.location.href = '/';
  } catch (err: any) {
    showToast(err.message || 'No se pudo ingresar.', 'error');
  }
});

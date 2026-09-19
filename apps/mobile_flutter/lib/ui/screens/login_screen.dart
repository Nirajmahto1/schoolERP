// ──────────────────────────────────────────────
// Login — email + password through the gateway. The same account shape
// works for every role; the router picks the shell after /auth/me.
//
// A collapsed "Server" section lets a phone on a network where the PC is
// unreachable point the app at the PC's IP manually (hotspot IP, LAN IP,
// or a public URL) — probed with /health before it is accepted.
// ──────────────────────────────────────────────

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/auth_state.dart';
import '../../core/host.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _server = TextEditingController(text: HostConfig.instance.host);
  bool _busy = false;
  bool _obscure = true;
  bool _showServer = false;
  String? _serverMsg;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _server.dispose();
    super.dispose();
  }

  Future<String> _applyServer() async {
    final err = await HostConfig.instance.setOverride(_server.text);
    final msg = err ?? 'Connected to ${HostConfig.instance.host} ✓';
    if (mounted) setState(() => _serverMsg = msg);
    return msg;
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() { _busy = true; _error = null; });
    final auth = context.read<AuthState>();
    try {
      await auth.login(_email.text.trim(), _password.text);
      // Navigation is handled by the root router listening to AuthState.
    } on ApiError catch (e) {
      setState(() => _error = e.detail);
    } catch (_) {
      setState(() => _error = 'Could not reach http://${HostConfig.instance.host}:4000. '
          'Expand "Server" below and point the app at your PC, or check that '
          'both devices are on the same Wi-Fi/hotspot.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _form,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Icon(Icons.school_rounded, size: 64, color: Theme.of(context).colorScheme.primary),
                    const SizedBox(height: 12),
                    Text('EduCore', style: Theme.of(context).textTheme.headlineMedium, textAlign: TextAlign.center),
                    const SizedBox(height: 4),
                    Text('Sign in to continue', style: Theme.of(context).textTheme.bodyMedium, textAlign: TextAlign.center),
                    const SizedBox(height: 28),
                    TextFormField(
                      controller: _email,
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [AutofillHints.email],
                      decoration: const InputDecoration(labelText: 'Email', prefixIcon: Icon(Icons.alternate_email)),
                      validator: (v) => (v == null || !v.contains('@')) ? 'Enter a valid email' : null,
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      controller: _password,
                      obscureText: _obscure,
                      decoration: InputDecoration(
                        labelText: 'Password',
                        prefixIcon: const Icon(Icons.lock_outline),
                        suffixIcon: IconButton(
                          icon: Icon(_obscure ? Icons.visibility_off_outlined : Icons.visibility_outlined),
                          onPressed: () => setState(() => _obscure = !_obscure),
                        ),
                      ),
                      onFieldSubmitted: (_) => _submit(),
                      validator: (v) => (v == null || v.length < 6) ? 'Enter your password' : null,
                    ),
                    const SizedBox(height: 8),
                    if (_error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error), textAlign: TextAlign.center),
                      ),
                    const SizedBox(height: 16),
                    FilledButton(
                      onPressed: _busy ? null : _submit,
                      child: _busy
                          ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Text('Sign in'),
                    ),
                    const SizedBox(height: 20),
                    // ── Dev escape hatch: point the app at any server ──
                    Card(
                      elevation: 0,
                      color: Theme.of(context).colorScheme.surfaceContainerHighest.withValues(alpha: 0.4),
                      child: Column(children: [
                        ListTile(
                          dense: true,
                          leading: const Icon(Icons.dns_outlined, size: 20),
                          title: const Text('Server', style: TextStyle(fontSize: 14)),
                          subtitle: Text('${HostConfig.instance.host}:4000', style: const TextStyle(fontSize: 12)),
                          trailing: Icon(_showServer ? Icons.expand_less : Icons.expand_more, size: 20),
                          onTap: () => setState(() => _showServer = !_showServer),
                        ),
                        if (_showServer) ...[
                          Padding(
                            padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
                            child: TextFormField(
                              controller: _server,
                              keyboardType: TextInputType.url,
                              decoration: const InputDecoration(
                                labelText: 'PC IP or URL',
                                hintText: '192.168.137.1',
                                isDense: true,
                              ),
                            ),
                          ),
                          Padding(
                            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                            child: Row(children: [
                              OutlinedButton(
                                onPressed: _busy
                                    ? null
                                    : () async {
                                        final msg = await _applyServer();
                                        if (mounted) setState(() => _serverMsg = msg);
                                      },
                                child: const Text('Test & save'),
                              ),
                              const SizedBox(width: 12),
                              Expanded(child: Text(_serverMsg ?? '', style: const TextStyle(fontSize: 12))),
                            ]),
                          ),
                        ],
                      ]),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

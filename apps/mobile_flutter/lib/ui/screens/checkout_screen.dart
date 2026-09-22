// ──────────────────────────────────────────────
// Razorpay checkout (BUILD_PLAN 4.1) — the mobile end of the gateway flow.
//
// A WebView loads checkout.js with OUR server-minted order (the amount always
// comes from the DB via /fees/checkout/orders — the client never states one).
// The checkout handler posts the signed callback {order_id, payment_id,
// signature} into Dart through a JS channel, and Dart calls
// /fees/checkout/verify — the production capture path the web console and
// webhooks share. The DB row is the source of truth; the modal is just UI.
// ──────────────────────────────────────────────

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../core/api.dart';

class RazorpayCheckoutScreen extends StatefulWidget {
  const RazorpayCheckoutScreen({
    super.key,
    required this.orderId,
    required this.amountRupees,
    required this.keyId,
    this.schoolName = 'School Fees',
    this.description = 'Fee payment',
  });

  final String orderId;
  final double amountRupees;
  final String keyId;
  final String schoolName;
  final String description;

  /// Pops with the verified payment ({captured: true, payment: {...}}) or
  /// {captured: false, reason: '...'} — null when the user dismissed.
  static Future<Map<String, dynamic>?> open(
    BuildContext context, {
    required String orderId,
    required double amountRupees,
    required String keyId,
    String schoolName = 'School Fees',
  }) {
    return Navigator.of(context).push<Map<String, dynamic>>(
      MaterialPageRoute(
        builder: (_) => RazorpayCheckoutScreen(
          orderId: orderId,
          amountRupees: amountRupees,
          keyId: keyId,
          schoolName: schoolName,
        ),
      ),
    );
  }

  @override
  State<RazorpayCheckoutScreen> createState() => _RazorpayCheckoutScreenState();
}

class _RazorpayCheckoutScreenState extends State<RazorpayCheckoutScreen> {
  late final WebViewController _controller;
  bool _verifying = false;

  String get _html => '''
<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc}
button{background:#2563eb;color:#fff;border:0;border-radius:10px;padding:14px 28px;font-size:16px}</style></head>
<body><button id="pay">Pay ₹${widget.amountRupees.toStringAsFixed(0)}</button>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
function post(obj){ RazorpayResult.postMessage(JSON.stringify(obj)); }
function openCheckout(){
  var rzp = new Razorpay({
    key: ${json.encode(widget.keyId)},
    order_id: ${json.encode(widget.orderId)},
    name: ${json.encode(widget.schoolName)},
    description: ${json.encode(widget.description)},
    theme: { color: '#2563eb' },
    handler: function(resp){ post({ event: 'success', resp: resp }); },
    modal: { ondismiss: function(){ post({ event: 'dismissed' }); } }
  });
  rzp.open();
}
document.getElementById('pay').onclick = openCheckout;
window.onload = function(){ setTimeout(openCheckout, 300); };
</script></body></html>''';

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel(
        'RazorpayResult',
        onMessageReceived: (msg) => _onResult(msg.message),
      )
      ..loadHtmlString(_html);
  }

  Future<void> _onResult(String raw) async {
    if (_verifying) return;
    final data = json.decode(raw) as Map<String, dynamic>;
    if (data['event'] == 'dismissed') {
      if (mounted) Navigator.of(context).pop({'captured': false, 'reason': 'DISMISSED'});
      return;
    }
    if (data['event'] != 'success') return;
    final resp = Map<String, dynamic>.from(data['resp'] as Map);
    setState(() => _verifying = true);
    try {
      // Production capture path: the server re-verifies the HMAC, re-fetches
      // the payment from Razorpay as the amount authority, then captures,
      // allocates and mints the receipt inside one transaction.
      final result = await ApiClient.instance.post('/fees/checkout/verify', body: {
        'razorpay_order_id': resp['razorpay_order_id'],
        'razorpay_payment_id': resp['razorpay_payment_id'],
        'razorpay_signature': resp['razorpay_signature'],
      });
      final map = Map<String, dynamic>.from(result as Map);
      if (mounted) Navigator.of(context).pop(map);
    } on ApiError catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.detail)));
        Navigator.of(context).pop({'captured': false, 'reason': 'VERIFY_FAILED'});
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not verify the payment')));
        Navigator.of(context).pop({'captured': false, 'reason': 'VERIFY_FAILED'});
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Fee Payment')),
      body: Stack(children: [
        WebViewWidget(controller: _controller),
        if (_verifying)
          Container(
            color: Colors.black38,
            alignment: Alignment.center,
            child: const Card(child: Padding(padding: EdgeInsets.all(20), child: CircularProgressIndicator())),
          ),
      ]),
    );
  }
}

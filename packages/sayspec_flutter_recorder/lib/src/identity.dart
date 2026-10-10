import 'package:flutter/material.dart';

import 'schema.dart';

/// Derives a durable widget identity from a live [Element].
///
/// The goal is not to produce a final assertion but to preserve enough
/// information for a reviewer or coding agent to pick a resilient Patrol
/// finder: explicit keys first, then semantics, then visible text.
///
/// A hit lands on the deepest render object, which is often a `Text` or a
/// gesture listener inside the interactive widget, so the nearest keyed or
/// labelled ancestor is what carries the identity: that is where a developer
/// puts the key.
SaySpecWidgetIdentity describeWidget(
  Element element, {
  bool includeBounds = true,
}) {
  final owning = _owningElement(element);
  return _describe(owning, _visibleText(element), includeBounds: includeBounds);
}

/// Identity of the text field that owns a focused [EditableText] element.
///
/// The text candidate comes from the field's label or hint, never from its
/// value: a recorded value belongs in the `enterText` payload, and a finder
/// built from typed text breaks as soon as it changes.
SaySpecWidgetIdentity describeTextField(Element editable) {
  final owning = _owningElement(editable);
  return _describe(owning, _visibleText(owning, includeEditableValues: false));
}

SaySpecWidgetIdentity _describe(
  Element owning,
  String? text, {
  bool includeBounds = true,
}) {
  final widget = owning.widget;
  final key = widget.key;
  final keyKind = _keyKind(key);
  final semanticLabel = _semanticsLabel(owning);
  final ancestors = _ancestorTypes(owning);
  return SaySpecWidgetIdentity(
    widgetType: widget.runtimeType.toString(),
    key: _keyValue(key),
    keyKind: keyKind,
    semanticLabel: semanticLabel,
    text: text,
    ancestors: ancestors,
    candidates: _candidates(
      widgetType: widget.runtimeType.toString(),
      key: _keyValue(key),
      keyKind: keyKind,
      semanticLabel: semanticLabel,
      text: text,
    ),
    bounds: includeBounds ? _bounds(owning) : null,
  );
}

/// The element that names what the user acted on.
///
/// Preference order mirrors how a developer builds a screen: the nearest
/// durable key, then a semantics label or tooltip, then the nearest interactive
/// widget, and only then the element that received the pointer. Walking the
/// whole ancestry at once (instead of stopping at the first interactive
/// wrapper) matters because Flutter nests an unkeyed `GestureDetector` inside
/// the keyed `FilledButton` a user actually touched.
Element _owningElement(Element element) {
  Element? identified;
  Element? interactive;
  Element? current = element;
  var depth = 0;
  while (current != null && depth < 40) {
    final widget = current.widget;
    if (widget is Scaffold || widget is MaterialApp || widget is Navigator) {
      break;
    }
    identified ??= _hasDurableIdentity(widget) ? current : null;
    interactive ??= isInteractiveWidget(widget) ? current : null;
    current = current._parent;
    depth += 1;
  }
  return identified ?? interactive ?? element;
}

/// A key a human wrote, not a framework slot name such as `_ScaffoldSlot.appBar`.
bool _hasDurableIdentity(Widget widget) {
  final key = widget.key;
  if (key is ValueKey<String>) {
    final value = key.value;
    if (value.isNotEmpty &&
        !value.startsWith('_') &&
        RegExp(r'^[A-Za-z][A-Za-z0-9_.:-]*$').hasMatch(value)) {
      return true;
    }
  }
  if (key is PageStorageKey<Object> && key.value.toString().isNotEmpty) {
    return true;
  }
  if (widget is Semantics && (widget.properties.label?.isNotEmpty ?? false)) {
    return true;
  }
  if (widget is Tooltip && (widget.message?.isNotEmpty ?? false)) return true;
  return false;
}

/// Widgets a reviewer would name, so a recorded action points at them instead
/// of at Flutter's internal viewport wrappers.
bool isInteractiveWidget(Widget widget) =>
    widget is ButtonStyleButton ||
    widget is InkWell ||
    widget is InkResponse ||
    widget is GestureDetector ||
    widget is TextField ||
    widget is TextFormField ||
    widget is EditableText ||
    widget is ListTile ||
    widget is Checkbox ||
    widget is Switch ||
    widget is Radio<Object> ||
    widget is Slider ||
    widget is DropdownButton<Object> ||
    widget is PopupMenuButton<Object> ||
    widget is IconButton ||
    widget is FloatingActionButton ||
    widget is TextButton ||
    widget is TabBar ||
    widget is NavigationBar ||
    widget is NavigationRail ||
    widget is Dismissible ||
    widget is ReorderableListView ||
    widget is RefreshIndicator ||
    widget is Drawer ||
    widget is BottomNavigationBar ||
    widget is ExpansionTile;

String? _keyKind(Key? key) {
  if (key == null) return null;
  if (key is GlobalKey) return 'global';
  if (key is ValueKey<String>) return 'value';
  if (key is ValueKey<Object>) return 'value';
  if (key is PageStorageKey<Object>) return 'pageStorage';
  return key.runtimeType.toString();
}

String? _keyValue(Key? key) {
  if (key == null) return null;
  if (key is ValueKey<Object>) return key.value.toString();
  if (key is GlobalKey) return key.toString();
  return key.toString();
}

/// Nearest visible text inside the widget, preferring the closest descendant.
///
/// An obscured field's value is never returned, since the screen shows only
/// dots and no text finder can match it; no field value is when
/// [includeEditableValues] is false.
String? _visibleText(Element element, {bool includeEditableValues = true}) {
  String? found;
  void visit(Element node) {
    if (found != null) return;
    final widget = node.widget;
    if (widget is Text &&
        widget.data != null &&
        widget.data!.trim().isNotEmpty) {
      found = widget.data!.trim();
      return;
    }
    if (widget is EditableText) {
      if (includeEditableValues &&
          !widget.obscureText &&
          widget.controller.text.isNotEmpty) {
        found = widget.controller.text;
      }
      return;
    }
    node.visitChildren(visit);
  }

  element.visitChildren(visit);
  return found;
}

/// Walks up to the first ancestor carrying semantics metadata.
String? _semanticsLabel(Element element) {
  Element? current = element;
  while (current != null) {
    final widget = current.widget;
    if (widget is Semantics) {
      final label = widget.properties.label;
      if (label != null && label.trim().isNotEmpty) return label.trim();
    }
    if (widget is Tooltip &&
        widget.message != null &&
        widget.message!.trim().isNotEmpty) {
      return widget.message!.trim();
    }
    current = current._parent;
  }
  return null;
}

List<String> _ancestorTypes(Element element) {
  final types = <String>[];
  Element? current = element._parent;
  while (current != null && types.length < 6) {
    types.add(current.widget.runtimeType.toString());
    current = current._parent;
  }
  return types;
}

Map<String, dynamic>? _bounds(Element element) {
  final object = element.renderObject;
  if (object is! RenderBox || !object.hasSize || !object.attached) return null;
  final origin = object.localToGlobal(Offset.zero);
  return <String, dynamic>{
    'x': origin.dx,
    'y': origin.dy,
    'width': object.size.width,
    'height': object.size.height,
  };
}

/// Ranked finder suggestions. The host shows these; it never asserts that the
/// first candidate is the intent of the recorded action.
List<Map<String, dynamic>> _candidates({
  required String widgetType,
  required String? key,
  required String? keyKind,
  required String? semanticLabel,
  required String? text,
}) {
  final candidates = <Map<String, dynamic>>[];
  if (key != null && keyKind != 'global' && !key.startsWith('[')) {
    candidates.add(<String, dynamic>{
      'kind': 'key',
      'value': key,
      'confidence': 'high',
    });
  }
  if (semanticLabel != null) {
    candidates.add(<String, dynamic>{
      'kind': 'semantics',
      'value': semanticLabel,
      'confidence': 'high',
    });
  }
  if (text != null) {
    final trimmed = text.length > 120 ? text.substring(0, 120) : text;
    candidates.add(<String, dynamic>{
      'kind': 'text',
      'value': trimmed,
      'confidence': 'medium',
    });
  }
  candidates.add(<String, dynamic>{
    'kind': 'type',
    'value': widgetType,
    'confidence': 'low',
  });
  return candidates;
}

extension on Element {
  Element? get _parent {
    Element? parent;
    visitAncestorElements((candidate) {
      parent = candidate;
      return false;
    });
    return parent;
  }
}

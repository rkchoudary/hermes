/**
 * Django 4+ patterns (incl. Django REST Framework).
 */
import type { Retriever } from '../index';

const DJANGO_PATTERNS = `
**Models, ViewSets, Serializers (DRF):**

\`\`\`python
# models.py
class Order(models.Model):
    user = models.ForeignKey(User, on_delete=models.PROTECT)
    total_cents = models.IntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

# serializers.py
class OrderSerializer(serializers.ModelSerializer):
    class Meta:
        model = Order
        fields = ['id', 'user', 'total_cents', 'created_at']

# views.py
class OrderViewSet(viewsets.ModelViewSet):
    queryset = Order.objects.select_related('user')
    serializer_class = OrderSerializer
    permission_classes = [IsAuthenticated]

# urls.py
router = DefaultRouter()
router.register(r'orders', OrderViewSet, basename='order')
\`\`\`

**Querysets — performance pitfalls:**

- Always \`select_related()\` for forward FKs you'll access in the response
- \`prefetch_related()\` for reverse FKs and M2M
- \`.only()\` / \`.defer()\` to avoid loading large fields
- N+1 queries are the #1 source of latency — measure with django-debug-toolbar
- \`.iterator(chunk_size=N)\` for large querysets to avoid loading all rows in RAM

**Migrations — production safety:**

- Adding a NOT NULL column with no default LOCKS the table (Postgres). Pattern:
  1. Migration A: add NULLable column
  2. Backfill in batches (RunPython)
  3. Migration B: ALTER … NOT NULL
- Removing a column: deploy code that doesn't read it, THEN run the migration
- Always test migrations on a clone of production volume

**Auth + permissions:**

\`\`\`python
class IsOwnerOrReadOnly(permissions.BasePermission):
    def has_object_permission(self, request, view, obj):
        if request.method in permissions.SAFE_METHODS:
            return True
        return obj.user == request.user
\`\`\`

**Common pitfalls:**
- Don't use \`signals\` for business logic — they're fragile + invisible
- Don't override \`save()\` for side effects; use explicit service functions
- DRF + Django CSRF: \`csrf_exempt\` on the API endpoints; rely on session auth or token
- \`async def\` views: only Django ≥4.1; ORM is still sync — use \`sync_to_async\`
`;

export const djangoRetriever: Retriever = {
  name: 'django@4+',
  matches(pack) {
    const hints = [...(pack.allowed_paths || []), ...(pack.references?.code_paths || []), pack.objective || ''].join(' ').toLowerCase();
    return /\.(py)\b.*manage\.py|django|drf|django.rest|viewsets|querysets|django.contrib/.test(hints);
  },
  async enrich(_pack) { return DJANGO_PATTERNS.trim(); },
};

import Link from 'next/link'
import { Box, Flex, Heading, Text } from '@radix-ui/themes'

export default function RegisterPage() {
  return (
    <Flex align="center" justify="center" style={{ minHeight: '100vh', backgroundColor: 'var(--color-background)' }}>
      <Box
        style={{
          width: 400,
          border: '1px solid var(--gray-6)',
          padding: 40,
          backgroundColor: 'var(--color-panel-solid)',
        }}
      >
        <Flex direction="column" gap="4">
          <Heading size="6" weight="bold">Pontis</Heading>
          <Text size="2" color="gray">L&apos;inscription arrive bientôt.</Text>
          <Text size="2">
            <Link href="/login" style={{ color: 'var(--gray-12)', fontWeight: 500 }}>
              Retour à la connexion
            </Link>
          </Text>
        </Flex>
      </Box>
    </Flex>
  )
}
